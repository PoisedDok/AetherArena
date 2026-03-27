'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

jest.mock('../../../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    ARTIFACTS: {
      SESSION_SWITCHED: 'artifacts:session_switched',
      SESSION_LOADED: 'artifacts:session_loaded',
      ARTIFACT_ADDED: 'artifacts:artifact_added'
    }
  }
}));

jest.mock('../../../../../src/domain/artifacts/utils/ArtifactNormalizer', () => ({
  normalizeArtifactPayload: jest.fn((raw, chatId) => ({
    ...raw,
    id: raw.artifact_id || raw.id,
    artifactId: raw.artifact_id || raw.id,
    chatId: raw.chat_id || chatId,
    role: raw.role || 'assistant',
    type: raw.type || 'code',
    format: raw.format || 'text'
  }))
}));

const ArtifactSessionManager = require('../../../../../src/domain/artifacts/services/ArtifactSessionManager');

function createDeps(overrides = {}) {
  return {
    eventBus: { emit: jest.fn() },
    traceabilityService: { registerArtifact: jest.fn() },
    storageAPI: { loadArtifacts: jest.fn().mockResolvedValue([]) },
    ...overrides
  };
}

describe('ArtifactSessionManager', () => {
  let manager, deps;

  beforeEach(() => {
    deps = createDeps();
    manager = new ArtifactSessionManager(deps);
  });

  describe('constructor', () => {
    it('initializes with null currentChatId', () => {
      expect(manager.currentChatId).toBeNull();
      expect(manager.sessions.size).toBe(0);
    });
  });

  describe('init()', () => {
    it('sets initialized flag', async () => {
      await manager.init();
      expect(manager._initialized).toBe(true);
    });

    it('is idempotent', async () => {
      await manager.init();
      await manager.init();
      expect(manager._initialized).toBe(true);
    });
  });

  describe('switchSession()', () => {
    it('loads session and sets currentChatId', async () => {
      const result = await manager.switchSession('chat-001');
      expect(manager.currentChatId).toBe('chat-001');
      expect(result.artifacts).toEqual([]);
      expect(result.groups).toEqual([]);
    });

    it('emits SESSION_SWITCHED event', async () => {
      await manager.switchSession('chat-001');
      expect(deps.eventBus.emit).toHaveBeenCalledWith('artifacts:session_switched', expect.objectContaining({
        chatId: 'chat-001'
      }));
    });

    it('returns cached session on same chatId', async () => {
      await manager.switchSession('chat-001');
      deps.storageAPI.loadArtifacts.mockClear();
      await manager.switchSession('chat-001');
      // Should not reload
      expect(deps.storageAPI.loadArtifacts).not.toHaveBeenCalled();
    });

    it('returns empty for null/empty chatId', async () => {
      const result = await manager.switchSession('');
      expect(result.artifacts).toEqual([]);
      expect(manager.currentChatId).toBeNull();
    });

    it('loads artifacts from storageAPI', async () => {
      deps.storageAPI.loadArtifacts.mockResolvedValue([
        { id: 'uuid-1', artifact_id: 'a1', type: 'code', chat_id: 'chat-001', role: 'assistant' }
      ]);
      const result = await manager.switchSession('chat-001');
      expect(result.artifacts).toHaveLength(1);
    });

    it('emits SESSION_LOADED event on first load', async () => {
      await manager.switchSession('chat-001');
      expect(deps.eventBus.emit).toHaveBeenCalledWith('artifacts:session_loaded', expect.objectContaining({
        chatId: 'chat-001'
      }));
    });
  });

  describe('addArtifact()', () => {
    it('adds artifact to current session', async () => {
      await manager.switchSession('chat-001');
      const artifact = { id: 'art-1', type: 'code', role: 'assistant', chatId: 'chat-001' };
      const result = manager.addArtifact(artifact);

      expect(result).toBeTruthy();
      expect(result.id).toBe('art-1');
      expect(result.category).toBeTruthy();
    });

    it('emits ARTIFACT_ADDED event', async () => {
      await manager.switchSession('chat-001');
      manager.addArtifact({ id: 'art-1', type: 'code', role: 'assistant', chatId: 'chat-001' });
      expect(deps.eventBus.emit).toHaveBeenCalledWith('artifacts:artifact_added', expect.objectContaining({
        artifactId: 'art-1'
      }));
    });

    it('registers with traceabilityService', async () => {
      await manager.switchSession('chat-001');
      manager.addArtifact({ id: 'art-1', type: 'code', role: 'assistant', chatId: 'chat-001', format: 'js' });
      expect(deps.traceabilityService.registerArtifact).toHaveBeenCalled();
    });

    it('returns null when artifact has no id', () => {
      expect(manager.addArtifact({})).toBeNull();
      expect(manager.addArtifact(null)).toBeNull();
    });

    it('returns null when no chatId available', () => {
      expect(manager.addArtifact({ id: 'a1' })).toBeNull();
    });

    it('creates session on-demand for new chatId', () => {
      const result = manager.addArtifact({ id: 'a1', chatId: 'new-chat', type: 'code', role: 'assistant' });
      expect(result).toBeTruthy();
      expect(manager.sessions.has('new-chat')).toBe(true);
    });

    it('links artifacts with parentId', async () => {
      await manager.switchSession('chat-001');
      manager.addArtifact({ id: 'parent', type: 'code', role: 'assistant', chatId: 'chat-001' });
      manager.addArtifact({ id: 'child', type: 'output', role: 'computer', chatId: 'chat-001', parentId: 'parent' });

      const linked = manager.getLinkedArtifacts('parent');
      expect(linked).toHaveLength(1);
      expect(linked[0].id).toBe('child');
    });
  });

  describe('getSessionArtifacts()', () => {
    it('returns empty for non-existent session', () => {
      const result = manager.getSessionArtifacts('nonexistent');
      expect(result.artifacts).toEqual([]);
      expect(result.groups).toEqual([]);
    });

    it('returns artifacts sorted by sessionIndex', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a2', chatId: 'c1', type: 'output', role: 'computer' });
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });
      const { artifacts } = manager.getSessionArtifacts('c1');
      expect(artifacts[0].id).toBe('a2');
      expect(artifacts[1].id).toBe('a1');
    });
  });

  describe('getArtifact()', () => {
    it('returns null when no session exists', () => {
      expect(manager.getArtifact('a1')).toBeNull();
    });

    it('returns artifact from current session', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });
      expect(manager.getArtifact('a1')).toBeTruthy();
    });

    it('returns artifact from specific session', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });
      expect(manager.getArtifact('a1', 'c1')).toBeTruthy();
    });
  });

  describe('getLinkedArtifacts()', () => {
    it('returns empty array when no links', () => {
      expect(manager.getLinkedArtifacts('a1')).toEqual([]);
    });
  });

  describe('getArtifactGroup()', () => {
    it('returns null when no session', () => {
      expect(manager.getArtifactGroup('msg-1')).toBeNull();
    });

    it('returns group with resolved artifacts', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant', messageId: 'msg-1' });

      const group = manager.getArtifactGroup('msg-1');
      expect(group).toBeTruthy();
      expect(group.artifacts).toHaveLength(1);
    });
  });

  describe('categorization', () => {
    it('categorizes assistant:code as code_written', async () => {
      await manager.switchSession('c1');
      const result = manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });
      expect(result.category).toBe('code_written');
    });

    it('categorizes computer:output as execution_output', async () => {
      await manager.switchSession('c1');
      const result = manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'output', role: 'computer' });
      expect(result.category).toBe('execution_output');
    });

    it('categorizes computer:console as execution_console', async () => {
      await manager.switchSession('c1');
      const result = manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'console', role: 'computer' });
      expect(result.category).toBe('execution_console');
    });
  });

  describe('getArtifactsByCategory()', () => {
    it('filters artifacts by category', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });
      manager.addArtifact({ id: 'a2', chatId: 'c1', type: 'output', role: 'computer' });

      const codeArtifacts = manager.getArtifactsByCategory('code_written', 'c1');
      expect(codeArtifacts).toHaveLength(1);
      expect(codeArtifacts[0].id).toBe('a1');
    });
  });

  describe('clearSession()', () => {
    it('removes session', async () => {
      await manager.switchSession('c1');
      manager.clearSession('c1');
      expect(manager.sessions.has('c1')).toBe(false);
    });
  });

  describe('clearAllSessions()', () => {
    it('clears everything', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant', parentId: 'p1' });
      manager.clearAllSessions();

      expect(manager.sessions.size).toBe(0);
      expect(manager.artifactLinks.size).toBe(0);
      expect(manager.currentChatId).toBeNull();
    });
  });

  describe('getStats()', () => {
    it('returns accurate stats', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });

      const stats = manager.getStats();
      expect(stats.currentChatId).toBe('c1');
      expect(stats.sessionCount).toBe(1);
      expect(stats.totalArtifacts).toBe(1);
    });

    it('returns frozen stats object', () => {
      const stats = manager.getStats();
      expect(() => { stats.extra = 'x'; }).toThrow();
    });
  });

  // =========================================================================
  // TARGETED BRANCH COVERAGE
  // =========================================================================

  describe('constructor fallback branches', () => {
    it('uses null for all optional deps when not provided', () => {
      const m = new ArtifactSessionManager();
      expect(m.eventBus).toBeNull();
      expect(m.traceabilityService).toBeNull();
      expect(m.storageAPI).toBeNull();
      // Logger gets the createLogger fallback
      expect(m.logger).toBeDefined();
    });
  });

  describe('_initializeStorageAPI branches', () => {
    it('early returns when storageAPI already set', () => {
      const m = new ArtifactSessionManager({ storageAPI: { loadArtifacts: jest.fn() } });
      m._initializeStorageAPI();
      // Should not throw or change storageAPI
      expect(m.storageAPI).toBeTruthy();
    });

    it('picks up globalThis.storageAPI when no storageAPI provided', () => {
      const mockStorage = { loadArtifacts: jest.fn() };
      globalThis.storageAPI = mockStorage;
      const m = new ArtifactSessionManager();
      m._initializeStorageAPI();
      expect(m.storageAPI).toBe(mockStorage);
      delete globalThis.storageAPI;
    });

    it('remains null when no globalThis.storageAPI', () => {
      delete globalThis.storageAPI;
      const m = new ArtifactSessionManager();
      m._initializeStorageAPI();
      expect(m.storageAPI).toBeNull();
    });
  });

  describe('init() error handling', () => {
    it('propagates error from _initializeStorageAPI', async () => {
      const m = new ArtifactSessionManager();
      m._initializeStorageAPI = jest.fn(() => { throw new Error('storage init fail'); });
      await expect(m.init()).rejects.toThrow('storage init fail');
    });
  });

  describe('switchSession edge cases', () => {
    it('returns cached result for same chatId (no reload)', async () => {
      await manager.switchSession('chat-001');
      deps.storageAPI.loadArtifacts.mockClear();
      const result = await manager.switchSession('chat-001');
      expect(deps.storageAPI.loadArtifacts).not.toHaveBeenCalled();
      expect(result.artifacts).toEqual([]);
    });

    it('handles non-string chatId as null', async () => {
      const result = await manager.switchSession(123);
      expect(manager.currentChatId).toBeNull();
      expect(result).toEqual({ artifacts: [], groups: [] });
    });

    it('handles whitespace-only chatId as null', async () => {
      const result = await manager.switchSession('   ');
      expect(manager.currentChatId).toBeNull();
      expect(result).toEqual({ artifacts: [], groups: [] });
    });

    it('propagates error from _loadSession', async () => {
      deps.storageAPI.loadArtifacts.mockRejectedValue(new Error('db fail'));
      await expect(manager.switchSession('chat-bad')).rejects.toThrow('db fail');
    });

    it('skips eventBus emit when no eventBus', async () => {
      const m = new ArtifactSessionManager({ storageAPI: deps.storageAPI });
      await m.switchSession('chat-001');
      // No throw, no emit (eventBus is null)
      expect(m.currentChatId).toBe('chat-001');
    });

    it('logs session switch with previous and next IDs', async () => {
      await manager.switchSession('chat-001');
      await manager.switchSession('chat-002');
      // Verify the logger was called (exact args not critical but should log)
      expect(manager.logger.info).toHaveBeenCalled();
    });
  });

  describe('_loadSession edge cases', () => {
    it('uses empty array when no storageAPI', async () => {
      const m = new ArtifactSessionManager({ eventBus: deps.eventBus });
      await m._loadSession('chat-001');
      const session = m.sessions.get('chat-001');
      expect(session).toBeDefined();
      expect(session.artifacts.size).toBe(0);
    });

    it('skips corrupted artifacts during normalization', async () => {
      const { normalizeArtifactPayload } = require('../../../../../src/domain/artifacts/utils/ArtifactNormalizer');
      normalizeArtifactPayload
        .mockImplementationOnce(() => ({ id: 'good', type: 'code', role: 'assistant' }))
        .mockImplementationOnce(() => { throw new Error('corrupt'); })
        .mockImplementationOnce(() => ({ id: 'also-good', type: 'output', role: 'computer' }));

      deps.storageAPI.loadArtifacts.mockResolvedValue([
        { id: 'good' }, { id: 'bad' }, { id: 'also-good' }
      ]);

      await manager._loadSession('chat-001');
      const session = manager.sessions.get('chat-001');
      expect(session.artifacts.size).toBe(2);
      expect(manager.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to normalize'),
        expect.objectContaining({ artifactId: 'bad' })
      );
    });

    it('skips eventBus emit when no eventBus', async () => {
      const m = new ArtifactSessionManager({ storageAPI: deps.storageAPI });
      await m._loadSession('chat-001');
      // No throw (eventBus is null)
      expect(m.sessions.has('chat-001')).toBe(true);
    });
  });

  describe('addArtifact edge cases', () => {
    it('uses currentChatId when artifact has no chatId', async () => {
      await manager.switchSession('chat-001');
      const result = manager.addArtifact({ id: 'a1', type: 'code', role: 'assistant' });
      expect(result).toBeTruthy();
      expect(manager.sessions.get('chat-001').artifacts.has('a1')).toBe(true);
    });

    it('skips traceabilityService when not provided', async () => {
      const m = new ArtifactSessionManager({
        eventBus: deps.eventBus,
        storageAPI: deps.storageAPI
      });
      await m.switchSession('c1');
      const result = m.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });
      expect(result).toBeTruthy();
      // No error (traceabilityService is null)
    });

    it('skips eventBus emit when not provided', async () => {
      const m = new ArtifactSessionManager({ storageAPI: deps.storageAPI });
      await m.switchSession('c1');
      const result = m.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });
      expect(result).toBeTruthy();
    });

    it('updates existing artifact preserving sessionIndex and addedAt', async () => {
      await manager.switchSession('c1');
      const first = manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });
      const originalAddedAt = first.addedAt;
      const originalIndex = first.sessionIndex;

      const updated = manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant', content: 'new' });
      expect(updated.sessionIndex).toBe(originalIndex);
      expect(updated.addedAt).toBe(originalAddedAt);
      expect(updated.content).toBe('new');
    });
  });

  describe('_categorizeArtifact all branches', () => {
    it('computer + code → execution_output', () => {
      const result = manager._categorizeArtifact({ role: 'computer', type: 'code' });
      expect(result).toBe('execution_output');
    });

    it('html format → html_output', () => {
      const result = manager._categorizeArtifact({ role: 'assistant', type: 'widget', format: 'html' });
      expect(result).toBe('html_output');
    });

    it('type output (non-computer) → general_output', () => {
      const result = manager._categorizeArtifact({ role: 'user', type: 'output' });
      expect(result).toBe('general_output');
    });

    it('unknown role/type → unknown', () => {
      const result = manager._categorizeArtifact({ role: 'user', type: 'blob', format: 'binary' });
      expect(result).toBe('unknown');
    });
  });

  describe('_linkArtifacts branches', () => {
    it('no parentId: no link created', () => {
      manager._linkArtifacts({ id: 'orphan' });
      expect(manager.artifactLinks.size).toBe(0);
    });

    it('creates new link set for first child', () => {
      manager._linkArtifacts({ id: 'child1', parentId: 'parent1' });
      expect(manager.artifactLinks.get('parent1').size).toBe(1);
    });

    it('adds to existing link set', () => {
      manager._linkArtifacts({ id: 'child1', parentId: 'parent1' });
      manager._linkArtifacts({ id: 'child2', parentId: 'parent1' });
      expect(manager.artifactLinks.get('parent1').size).toBe(2);
    });
  });

  describe('_groupArtifacts branches', () => {
    const makeSession = () => ({
      groups: new Map(),
    });

    it('no messageId or correlationId: no group', () => {
      const session = makeSession();
      manager._groupArtifacts(session, { id: 'a1' });
      expect(session.groups.size).toBe(0);
    });

    it('uses correlationId as fallback', () => {
      const session = makeSession();
      manager._groupArtifacts(session, { id: 'a1', correlationId: 'corr-1', category: 'unknown' });
      expect(session.groups.has('corr-1')).toBe(true);
    });

    it('adds to existing group without duplicate', () => {
      const session = makeSession();
      manager._groupArtifacts(session, { id: 'a1', messageId: 'm1', category: 'unknown' });
      manager._groupArtifacts(session, { id: 'a1', messageId: 'm1', category: 'unknown' }); // duplicate
      expect(session.groups.get('m1').artifacts).toHaveLength(1);
    });

    it('classifies code_written into codeArtifacts', () => {
      const session = makeSession();
      manager._groupArtifacts(session, { id: 'a1', messageId: 'm1', category: 'code_written' });
      expect(session.groups.get('m1').codeArtifacts).toContain('a1');
    });

    it('classifies execution_output into outputArtifacts', () => {
      const session = makeSession();
      manager._groupArtifacts(session, { id: 'a1', messageId: 'm1', category: 'execution_output' });
      expect(session.groups.get('m1').outputArtifacts).toContain('a1');
    });

    it('classifies general_output into outputArtifacts', () => {
      const session = makeSession();
      manager._groupArtifacts(session, { id: 'a1', messageId: 'm1', category: 'general_output' });
      expect(session.groups.get('m1').outputArtifacts).toContain('a1');
    });

    it('classifies execution_console into outputArtifacts', () => {
      const session = makeSession();
      manager._groupArtifacts(session, { id: 'a1', messageId: 'm1', category: 'execution_console' });
      expect(session.groups.get('m1').outputArtifacts).toContain('a1');
    });

    it('unknown category goes to neither code nor output', () => {
      const session = makeSession();
      manager._groupArtifacts(session, { id: 'a1', messageId: 'm1', category: 'unknown' });
      expect(session.groups.get('m1').codeArtifacts).toHaveLength(0);
      expect(session.groups.get('m1').outputArtifacts).toHaveLength(0);
    });

    it('uses _categorizeArtifact when no category set', () => {
      const session = makeSession();
      manager._groupArtifacts(session, { id: 'a1', messageId: 'm1', role: 'assistant', type: 'code' });
      expect(session.groups.get('m1').codeArtifacts).toContain('a1');
    });
  });

  describe('getArtifact edge cases', () => {
    it('uses explicit chatId over currentChatId', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant' });
      // Switch to a different session
      await manager.switchSession('c2');
      // Should still find artifact from c1 via explicit chatId
      expect(manager.getArtifact('a1', 'c1')).toBeTruthy();
      // Should not find in c2 — getArtifact normalizes missing to null
      expect(manager.getArtifact('a1')).toBeNull();
    });

    it('returns null when session exists but artifact does not', async () => {
      await manager.switchSession('c1');
      expect(manager.getArtifact('nonexistent')).toBeNull();
    });
  });

  describe('getLinkedArtifacts edge cases', () => {
    it('returns empty when no currentChatId', () => {
      manager.artifactLinks.set('parent', new Set(['child']));
      manager.currentChatId = null;
      expect(manager.getLinkedArtifacts('parent')).toEqual([]);
    });

    it('returns empty when session does not exist', () => {
      manager.artifactLinks.set('parent', new Set(['child']));
      manager.currentChatId = 'ghost-session';
      expect(manager.getLinkedArtifacts('parent')).toEqual([]);
    });

    it('filters out unresolved artifact IDs', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'child1', chatId: 'c1', type: 'code', role: 'assistant', parentId: 'parent' });
      // Manually add a broken link
      manager.artifactLinks.get('parent').add('nonexistent');
      const linked = manager.getLinkedArtifacts('parent');
      expect(linked).toHaveLength(1);
      expect(linked[0].id).toBe('child1');
    });
  });

  describe('getArtifactGroup edge cases', () => {
    it('returns null for explicit chatId with no session', () => {
      expect(manager.getArtifactGroup('msg-1', 'ghost')).toBeNull();
    });

    it('returns null for non-existent group in valid session', async () => {
      await manager.switchSession('c1');
      expect(manager.getArtifactGroup('nonexistent')).toBeNull();
    });

    it('filters out unresolved artifacts in group', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant', messageId: 'msg-1' });
      // Manually add a broken reference
      const session = manager.sessions.get('c1');
      session.groups.get('msg-1').artifacts.push('ghost-id');
      const group = manager.getArtifactGroup('msg-1');
      expect(group.artifacts).toHaveLength(1);
    });
  });

  describe('getSessionArtifacts group resolution', () => {
    it('resolves group artifacts and filters broken refs', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'a1', chatId: 'c1', type: 'code', role: 'assistant', messageId: 'msg-1' });
      // Add broken ref to group
      const session = manager.sessions.get('c1');
      session.groups.get('msg-1').artifacts.push('ghost-id');

      const { groups } = manager.getSessionArtifacts('c1');
      expect(groups).toHaveLength(1);
      expect(groups[0].artifacts).toHaveLength(1);
    });
  });

  describe('getStats with links', () => {
    it('counts total links across sessions', async () => {
      await manager.switchSession('c1');
      manager.addArtifact({ id: 'parent', chatId: 'c1', type: 'code', role: 'assistant' });
      manager.addArtifact({ id: 'child1', chatId: 'c1', type: 'output', role: 'computer', parentId: 'parent' });
      manager.addArtifact({ id: 'child2', chatId: 'c1', type: 'output', role: 'computer', parentId: 'parent' });

      const stats = manager.getStats();
      expect(stats.totalLinks).toBe(2);
    });
  });
});
