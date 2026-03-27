'use strict';

/**
 * SessionManager Unit Tests
 * ============================================================================
 * Tests parseSessionId, compareSessionIds, ChatSession, SessionManager.
 * Covers: ID generation, sequence tracking, parent-child linking,
 * entity tree, session lifecycle, events, stats, export.
 *
 * Test environment: node (tests/unit/core/** → unit:node project)
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSessionLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  trace: jest.fn(),
};

jest.mock('../../../../src/core/utils/logger', () => ({
  logger: {
    child: jest.fn(() => mockSessionLogger),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  },
  Logger: jest.fn(),
  LOG_LEVELS: {},
  getLogger: jest.fn(),
  createLogger: jest.fn(),
}));

const {
  SessionManager,
  sessionManager,
  ID_TYPES,
  parseSessionId,
  compareSessionIds,
} = require('../../../../src/core/session/SessionManager');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager module', () => {
  // =========================================================================
  // ID_TYPES
  // =========================================================================

  describe('ID_TYPES', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(ID_TYPES)).toBe(true);
    });

    it('contains all expected types', () => {
      expect(ID_TYPES.USER_MESSAGE).toBe('UM');
      expect(ID_TYPES.ASSISTANT_MESSAGE).toBe('AM');
      expect(ID_TYPES.ASSISTANT_CODE).toBe('AC');
      expect(ID_TYPES.ASSISTANT_OUTPUT).toBe('AO');
      expect(ID_TYPES.ASSISTANT_HTML).toBe('AH');
      expect(ID_TYPES.USER_ATTACHMENT).toBe('UA');
    });
  });

  // =========================================================================
  // parseSessionId
  // =========================================================================

  describe('parseSessionId()', () => {
    it('parses valid ID into components', () => {
      const result = parseSessionId('chat123_000001_UM');
      expect(result).toEqual({ chatId: 'chat123', sequence: 1, type: 'UM' });
    });

    it('parses high sequence number', () => {
      const result = parseSessionId('abc_999999_AM');
      expect(result).toEqual({ chatId: 'abc', sequence: 999999, type: 'AM' });
    });

    it('returns null for null input', () => {
      expect(parseSessionId(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(parseSessionId(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseSessionId('')).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(parseSessionId(42)).toBeNull();
      expect(parseSessionId({})).toBeNull();
    });

    it('returns null for wrong number of parts (too few)', () => {
      expect(parseSessionId('chat123_000001')).toBeNull();
    });

    it('returns null for wrong number of parts (too many)', () => {
      expect(parseSessionId('chat_123_000001_UM_extra')).toBeNull();
    });

    it('returns null when sequence is not a number', () => {
      expect(parseSessionId('chat_abc_UM')).toBeNull();
    });

    it('returns null when chatId is empty', () => {
      expect(parseSessionId('_000001_UM')).toBeNull();
    });

    it('returns null when type is empty', () => {
      expect(parseSessionId('chat_000001_')).toBeNull();
    });
  });

  // =========================================================================
  // compareSessionIds
  // =========================================================================

  describe('compareSessionIds()', () => {
    it('returns 0 for identical IDs', () => {
      expect(compareSessionIds('a_000001_UM', 'a_000001_UM')).toBe(0);
    });

    it('returns negative when first sequence < second', () => {
      expect(compareSessionIds('a_000001_UM', 'a_000002_UM')).toBeLessThan(0);
    });

    it('returns positive when first sequence > second', () => {
      expect(compareSessionIds('a_000005_UM', 'a_000002_UM')).toBeGreaterThan(0);
    });

    it('compares chat IDs lexicographically when different', () => {
      expect(compareSessionIds('alpha_000001_UM', 'beta_000001_UM')).toBe(-1);
      expect(compareSessionIds('beta_000001_UM', 'alpha_000001_UM')).toBe(1);
    });

    it('returns 0 when either ID is invalid', () => {
      expect(compareSessionIds('invalid', 'a_000001_UM')).toBe(0);
      expect(compareSessionIds('a_000001_UM', 'invalid')).toBe(0);
      expect(compareSessionIds('invalid', 'also-invalid')).toBe(0);
    });
  });

  // =========================================================================
  // ChatSession (via SessionManager.getSession)
  // =========================================================================

  describe('ChatSession', () => {
    let mgr;

    beforeEach(() => {
      mgr = new SessionManager();
    });

    it('initialises with correct chatId and zero sequence', () => {
      const session = mgr.getSession('chat1');
      expect(session.chatId).toBe('chat1');
      expect(session.sequence).toBe(0);
      expect(session.idMap.size).toBe(0);
      expect(session.linkMap.size).toBe(0);
    });

    describe('nextId()', () => {
      it('generates sequential IDs with correct format', () => {
        const session = mgr.getSession('chat1');
        const id1 = session.nextId('UM');
        const id2 = session.nextId('AM');
        const id3 = session.nextId('AC');

        expect(id1).toBe('chat1_000001_UM');
        expect(id2).toBe('chat1_000002_AM');
        expect(id3).toBe('chat1_000003_AC');
      });

      it('pads sequence to 6 digits', () => {
        const session = mgr.getSession('c');
        const id = session.nextId('UM');
        expect(id).toBe('c_000001_UM');
      });

      it('stores metadata for generated ID', () => {
        const session = mgr.getSession('chat1');
        const id = session.nextId('UM');
        const meta = session.getMetadata(id);

        expect(meta).not.toBeNull();
        expect(meta.sequence).toBe(1);
        expect(meta.type).toBe('UM');
        expect(meta.parentId).toBeNull();
        expect(meta.createdAt).toBeGreaterThan(0);
      });

      it('stores parent link when parentId provided', () => {
        const session = mgr.getSession('chat1');
        const umId = session.nextId('UM');
        const amId = session.nextId('AM', umId);

        expect(session.getParent(amId)).toBe(umId);
        expect(session.linkMap.has(amId)).toBe(true);
      });

      it('does not store link when no parentId', () => {
        const session = mgr.getSession('chat1');
        const id = session.nextId('UM');
        expect(session.linkMap.has(id)).toBe(false);
      });
    });

    describe('getParent()', () => {
      it('returns null for unlinked ID', () => {
        const session = mgr.getSession('chat1');
        const id = session.nextId('UM');
        expect(session.getParent(id)).toBeNull();
      });

      it('returns null for unknown ID', () => {
        const session = mgr.getSession('chat1');
        expect(session.getParent('nonexistent')).toBeNull();
      });
    });

    describe('getChildren()', () => {
      it('returns sorted children for a parent', () => {
        const session = mgr.getSession('chat1');
        const parentId = session.nextId('UM');
        const child1 = session.nextId('AM', parentId);
        const child2 = session.nextId('AC', parentId);
        const child3 = session.nextId('AH', parentId);

        const children = session.getChildren(parentId);
        expect(children).toEqual([child1, child2, child3]);
      });

      it('returns empty array when no children', () => {
        const session = mgr.getSession('chat1');
        const id = session.nextId('UM');
        expect(session.getChildren(id)).toEqual([]);
      });
    });

    describe('getMetadata()', () => {
      it('returns null for unknown ID', () => {
        const session = mgr.getSession('chat1');
        expect(session.getMetadata('unknown')).toBeNull();
      });
    });

    describe('getTree()', () => {
      it('returns full entity tree with children', () => {
        const session = mgr.getSession('chat1');
        const umId = session.nextId('UM');
        const amId = session.nextId('AM', umId);
        const acId = session.nextId('AC', amId);

        const tree = session.getTree(umId);
        expect(tree).not.toBeNull();
        expect(tree.id).toBe(umId);
        expect(tree.children).toHaveLength(1);
        expect(tree.children[0].id).toBe(amId);
        expect(tree.children[0].children).toHaveLength(1);
        expect(tree.children[0].children[0].id).toBe(acId);
      });

      it('returns null for unknown root', () => {
        const session = mgr.getSession('chat1');
        expect(session.getTree('nonexistent')).toBeNull();
      });

      it('returns leaf node with empty children', () => {
        const session = mgr.getSession('chat1');
        const id = session.nextId('UM');
        const tree = session.getTree(id);
        expect(tree.children).toEqual([]);
      });
    });

    describe('getCurrentSequence()', () => {
      it('returns current sequence', () => {
        const session = mgr.getSession('chat1');
        expect(session.getCurrentSequence()).toBe(0);
        session.nextId('UM');
        expect(session.getCurrentSequence()).toBe(1);
        session.nextId('AM');
        expect(session.getCurrentSequence()).toBe(2);
      });
    });

    describe('getStats()', () => {
      it('returns complete stats', () => {
        const session = mgr.getSession('chat1');
        session.nextId('UM');
        session.nextId('UM');
        session.nextId('AM');

        const stats = session.getStats();
        expect(stats.chatId).toBe('chat1');
        expect(stats.totalEntities).toBe(3);
        expect(stats.currentSequence).toBe(3);
        expect(stats.typeCount).toEqual({ UM: 2, AM: 1 });
        expect(stats.createdAt).toBeGreaterThan(0);
        expect(stats.lastActivity).toBeGreaterThan(0);
        expect(stats.age).toBeGreaterThanOrEqual(0);
      });

      it('returns zeros for fresh session', () => {
        const session = mgr.getSession('empty');
        const stats = session.getStats();
        expect(stats.totalEntities).toBe(0);
        expect(stats.currentSequence).toBe(0);
        expect(stats.typeCount).toEqual({});
      });
    });
  });

  // =========================================================================
  // SessionManager
  // =========================================================================

  describe('SessionManager', () => {
    let mgr;

    beforeEach(() => {
      jest.clearAllMocks();
      mgr = new SessionManager();
    });

    describe('constructor', () => {
      it('initialises with empty sessions and no active chat', () => {
        expect(mgr.sessions.size).toBe(0);
        expect(mgr.currentChatId).toBeNull();
      });

      it('extends EventEmitter', () => {
        expect(typeof mgr.on).toBe('function');
        expect(typeof mgr.emit).toBe('function');
      });
    });

    describe('getSession()', () => {
      it('creates new session for unknown chatId', () => {
        const handler = jest.fn();
        mgr.on('session:created', handler);

        const session = mgr.getSession('new-chat');
        expect(session.chatId).toBe('new-chat');
        expect(mgr.sessions.size).toBe(1);
        expect(handler).toHaveBeenCalledWith({ chatId: 'new-chat' });
      });

      it('returns existing session for known chatId', () => {
        const s1 = mgr.getSession('chat');
        const s2 = mgr.getSession('chat');
        expect(s1).toBe(s2); // same reference
        expect(mgr.sessions.size).toBe(1);
      });

      it('throws when chatId is falsy', () => {
        expect(() => mgr.getSession('')).toThrow('Chat ID required');
        expect(() => mgr.getSession(null)).toThrow('Chat ID required');
        expect(() => mgr.getSession(undefined)).toThrow('Chat ID required');
      });
    });

    describe('setActiveChat()', () => {
      it('sets current chat ID', () => {
        mgr.setActiveChat('active-chat');
        expect(mgr.currentChatId).toBe('active-chat');
      });

      it('emits session:active event', () => {
        const handler = jest.fn();
        mgr.on('session:active', handler);
        mgr.setActiveChat('chat-x');
        expect(handler).toHaveBeenCalledWith({ chatId: 'chat-x' });
      });
    });

    describe('getActiveSession()', () => {
      it('returns null when no active chat', () => {
        expect(mgr.getActiveSession()).toBeNull();
      });

      it('returns session for active chat', () => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        const session = mgr.getActiveSession();
        expect(session.chatId).toBe('chat1');
      });
    });

    describe('nextId()', () => {
      it('generates ID in active session', () => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        const id = mgr.nextId('UM');
        expect(id).toBe('chat1_000001_UM');
      });

      it('emits id:generated event', () => {
        const handler = jest.fn();
        mgr.on('id:generated', handler);
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        const id = mgr.nextId('UM');
        expect(handler).toHaveBeenCalledWith({
          chatId: 'chat1',
          id,
          type: 'UM',
          parentId: null,
        });
      });

      it('throws when no active session', () => {
        expect(() => mgr.nextId('UM')).toThrow('No active chat session');
      });

      it('supports parentId', () => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        const umId = mgr.nextId('UM');
        const amId = mgr.nextId('AM', umId);
        expect(amId).toBe('chat1_000002_AM');
      });
    });

    describe('convenience ID methods', () => {
      beforeEach(() => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
      });

      it('nextUserMessageId()', () => {
        const id = mgr.nextUserMessageId();
        expect(id).toMatch(/_UM$/);
      });

      it('nextAssistantMessageId()', () => {
        const umId = mgr.nextUserMessageId();
        const amId = mgr.nextAssistantMessageId(umId);
        expect(amId).toMatch(/_AM$/);
      });

      it('nextAssistantMessageId() without parent', () => {
        const amId = mgr.nextAssistantMessageId();
        expect(amId).toMatch(/_AM$/);
      });

      it('nextCodeArtifactId()', () => {
        const id = mgr.nextCodeArtifactId('parent');
        expect(id).toMatch(/_AC$/);
      });

      it('nextOutputArtifactId()', () => {
        const id = mgr.nextOutputArtifactId('parent');
        expect(id).toMatch(/_AO$/);
      });

      it('nextHtmlArtifactId()', () => {
        const id = mgr.nextHtmlArtifactId('parent');
        expect(id).toMatch(/_AH$/);
      });

      it('nextAttachmentId()', () => {
        const id = mgr.nextAttachmentId('parent');
        expect(id).toMatch(/_UA$/);
      });
    });

    describe('parseId() / compareIds()', () => {
      it('delegates to parseSessionId', () => {
        expect(mgr.parseId('chat_000001_UM')).toEqual({
          chatId: 'chat', sequence: 1, type: 'UM',
        });
      });

      it('delegates to compareSessionIds', () => {
        expect(mgr.compareIds('a_000001_UM', 'a_000002_UM')).toBeLessThan(0);
      });
    });

    describe('getParent()', () => {
      it('returns parent from correct session', () => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        const umId = mgr.nextId('UM');
        const amId = mgr.nextId('AM', umId);

        expect(mgr.getParent(amId)).toBe(umId);
      });

      it('returns null for invalid ID', () => {
        expect(mgr.getParent('invalid')).toBeNull();
      });

      it('returns null for unknown session', () => {
        expect(mgr.getParent('unknown_000001_UM')).toBeNull();
      });
    });

    describe('getChildren()', () => {
      it('returns children from correct session', () => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        const umId = mgr.nextId('UM');
        const amId = mgr.nextId('AM', umId);

        expect(mgr.getChildren(umId)).toEqual([amId]);
      });

      it('returns empty array for invalid ID', () => {
        expect(mgr.getChildren('invalid')).toEqual([]);
      });

      it('returns empty array for unknown session', () => {
        expect(mgr.getChildren('unknown_000001_UM')).toEqual([]);
      });
    });

    describe('getTree()', () => {
      it('returns tree from correct session', () => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        const umId = mgr.nextId('UM');
        mgr.nextId('AM', umId);

        const tree = mgr.getTree(umId);
        expect(tree).not.toBeNull();
        expect(tree.id).toBe(umId);
        expect(tree.children).toHaveLength(1);
      });

      it('returns null for invalid ID', () => {
        expect(mgr.getTree('invalid')).toBeNull();
      });

      it('returns null for unknown session', () => {
        expect(mgr.getTree('unknown_000001_UM')).toBeNull();
      });
    });

    describe('clearSession()', () => {
      it('removes session and emits event', () => {
        const handler = jest.fn();
        mgr.on('session:cleared', handler);
        mgr.getSession('chat1');
        mgr.clearSession('chat1');

        expect(mgr.sessions.has('chat1')).toBe(false);
        expect(handler).toHaveBeenCalledWith({ chatId: 'chat1' });
      });

      it('resets currentChatId if clearing active session', () => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        mgr.clearSession('chat1');
        expect(mgr.currentChatId).toBeNull();
      });

      it('does not reset currentChatId if clearing different session', () => {
        mgr.getSession('chat1');
        mgr.getSession('chat2');
        mgr.setActiveChat('chat1');
        mgr.clearSession('chat2');
        expect(mgr.currentChatId).toBe('chat1');
      });

      it('is safe to call on nonexistent session', () => {
        const handler = jest.fn();
        mgr.on('session:cleared', handler);
        expect(() => mgr.clearSession('nonexistent')).not.toThrow();
        expect(handler).not.toHaveBeenCalled();
      });
    });

    describe('clearAll()', () => {
      it('clears all sessions and resets state', () => {
        const handler = jest.fn();
        mgr.on('session:cleared:all', handler);

        mgr.getSession('chat1');
        mgr.getSession('chat2');
        mgr.setActiveChat('chat1');
        mgr.clearAll();

        expect(mgr.sessions.size).toBe(0);
        expect(mgr.currentChatId).toBeNull();
        expect(handler).toHaveBeenCalled();
      });
    });

    describe('getActiveSessions()', () => {
      it('returns all session IDs', () => {
        mgr.getSession('chat1');
        mgr.getSession('chat2');
        mgr.getSession('chat3');

        const ids = mgr.getActiveSessions();
        expect(ids.sort()).toEqual(['chat1', 'chat2', 'chat3']);
      });

      it('returns empty array when no sessions', () => {
        expect(mgr.getActiveSessions()).toEqual([]);
      });
    });

    describe('getSessionStats()', () => {
      it('returns stats for existing session', () => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        mgr.nextId('UM');

        const stats = mgr.getSessionStats('chat1');
        expect(stats).not.toBeNull();
        expect(stats.totalEntities).toBe(1);
      });

      it('returns null for unknown session', () => {
        expect(mgr.getSessionStats('unknown')).toBeNull();
      });
    });

    describe('getAllStats()', () => {
      it('returns stats for all sessions', () => {
        mgr.getSession('chat1');
        mgr.getSession('chat2');
        mgr.setActiveChat('chat1');
        mgr.nextId('UM');

        const stats = mgr.getAllStats();
        expect(stats.chat1).toBeDefined();
        expect(stats.chat2).toBeDefined();
        expect(stats.chat1.totalEntities).toBe(1);
        expect(stats.chat2.totalEntities).toBe(0);
      });
    });

    describe('exportSession()', () => {
      it('exports full session data', () => {
        mgr.getSession('chat1');
        mgr.setActiveChat('chat1');
        const umId = mgr.nextId('UM');
        const amId = mgr.nextId('AM', umId);

        const data = mgr.exportSession('chat1');
        expect(data.chatId).toBe('chat1');
        expect(data.sequence).toBe(2);
        expect(data.entities).toHaveLength(2);

        const umEntity = data.entities.find(e => e.id === umId);
        expect(umEntity.type).toBe('UM');
        expect(umEntity.parent).toBeNull();
        expect(umEntity.children).toEqual([amId]);

        const amEntity = data.entities.find(e => e.id === amId);
        expect(amEntity.type).toBe('AM');
        expect(amEntity.parent).toBe(umId);

        expect(data.stats).toBeDefined();
        expect(data.stats.totalEntities).toBe(2);
      });

      it('returns null for unknown session', () => {
        expect(mgr.exportSession('unknown')).toBeNull();
      });
    });
  });

  // =========================================================================
  // Singleton
  // =========================================================================

  describe('singleton instance', () => {
    it('exports a sessionManager singleton', () => {
      expect(sessionManager).toBeInstanceOf(SessionManager);
    });
  });
});
