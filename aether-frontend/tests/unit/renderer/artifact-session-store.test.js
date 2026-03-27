'use strict';

/**
 * Tests for ArtifactSessionStore — in-memory session cache for artifacts per chat.
 *
 * Source: src/renderer/shared/state/artifactSessionStore.js
 * Architecture: Pure state management. Map<chatId, Map<artifactId, artifact>>.
 * Dependencies: NONE.
 */

const { ArtifactSessionStore } = require('../../../src/renderer/shared/state/artifactSessionStore');

describe('ArtifactSessionStore', () => {
  let store;

  beforeEach(() => {
    store = new ArtifactSessionStore();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Constructor
  // ═══════════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('initializes with empty sessions Map', () => {
      expect(store.sessions).toBeInstanceOf(Map);
      expect(store.sessions.size).toBe(0);
    });

    it('initializes currentChatId as null', () => {
      expect(store.currentChatId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // init()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('init()', () => {
    it('returns true', async () => {
      const result = await store.init();
      expect(result).toBe(true);
    });

    it('is idempotent — calling twice returns true both times', async () => {
      expect(await store.init()).toBe(true);
      expect(await store.init()).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // switchSession()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('switchSession()', () => {
    it('returns empty result when chatId is null', async () => {
      const result = await store.switchSession(null);
      expect(result).toEqual({ chatId: null, artifacts: [] });
    });

    it('returns empty result when chatId is undefined', async () => {
      const result = await store.switchSession(undefined);
      expect(result).toEqual({ chatId: null, artifacts: [] });
    });

    it('returns empty result when chatId is empty string', async () => {
      const result = await store.switchSession('');
      expect(result).toEqual({ chatId: null, artifacts: [] });
    });

    it('sets currentChatId on valid chatId', async () => {
      await store.switchSession('chat-1');
      expect(store.currentChatId).toBe('chat-1');
    });

    it('returns empty artifacts for new chat (no session data)', async () => {
      const result = await store.switchSession('chat-new');
      expect(result).toEqual({ chatId: 'chat-new', artifacts: [] });
    });

    it('returns existing artifacts when session has data', async () => {
      const artifact = { id: 'art-1', content: 'hello', chatId: 'chat-1' };
      store.addArtifact(artifact, 'chat-1');

      const result = await store.switchSession('chat-1');
      expect(result.chatId).toBe('chat-1');
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].id).toBe('art-1');
      expect(result.artifacts[0].content).toBe('hello');
    });

    it('switches between different sessions', async () => {
      store.addArtifact({ id: 'a1', chatId: 'chat-1' }, 'chat-1');
      store.addArtifact({ id: 'a2', chatId: 'chat-2' }, 'chat-2');

      const r1 = await store.switchSession('chat-1');
      expect(r1.artifacts).toHaveLength(1);
      expect(r1.artifacts[0].id).toBe('a1');
      expect(store.currentChatId).toBe('chat-1');

      const r2 = await store.switchSession('chat-2');
      expect(r2.artifacts).toHaveLength(1);
      expect(r2.artifacts[0].id).toBe('a2');
      expect(store.currentChatId).toBe('chat-2');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getSessionArtifacts()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getSessionArtifacts()', () => {
    it('returns empty result when chatId is null', () => {
      const result = store.getSessionArtifacts(null);
      expect(result).toEqual({ chatId: null, artifacts: [] });
    });

    it('returns empty result when chatId is undefined', () => {
      const result = store.getSessionArtifacts(undefined);
      expect(result).toEqual({ chatId: null, artifacts: [] });
    });

    it('returns empty result when chatId is empty string', () => {
      const result = store.getSessionArtifacts('');
      expect(result).toEqual({ chatId: null, artifacts: [] });
    });

    it('returns empty artifacts for chatId with no session', () => {
      const result = store.getSessionArtifacts('nonexistent');
      expect(result).toEqual({ chatId: 'nonexistent', artifacts: [] });
    });

    it('returns all artifacts for chatId with data', () => {
      store.addArtifact({ id: 'a1', type: 'code' }, 'chat-1');
      store.addArtifact({ id: 'a2', type: 'output' }, 'chat-1');

      const result = store.getSessionArtifacts('chat-1');
      expect(result.chatId).toBe('chat-1');
      expect(result.artifacts).toHaveLength(2);

      const ids = result.artifacts.map(a => a.id);
      expect(ids).toContain('a1');
      expect(ids).toContain('a2');
    });

    it('does not return artifacts from other sessions', () => {
      store.addArtifact({ id: 'a1', chatId: 'chat-1' }, 'chat-1');
      store.addArtifact({ id: 'a2', chatId: 'chat-2' }, 'chat-2');

      const result = store.getSessionArtifacts('chat-1');
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].id).toBe('a1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // addArtifact()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('addArtifact()', () => {
    it('does nothing when artifact is null', () => {
      store.addArtifact(null);
      expect(store.sessions.size).toBe(0);
    });

    it('does nothing when artifact is undefined', () => {
      store.addArtifact(undefined);
      expect(store.sessions.size).toBe(0);
    });

    it('does nothing when artifact has no id', () => {
      store.addArtifact({ content: 'no id' });
      expect(store.sessions.size).toBe(0);
    });

    it('does nothing when artifact.id is empty string', () => {
      store.addArtifact({ id: '' });
      expect(store.sessions.size).toBe(0);
    });

    it('does nothing when no chatId can be resolved (no override, no artifact.chatId, no currentChatId)', () => {
      store.addArtifact({ id: 'a1' });
      expect(store.sessions.size).toBe(0);
    });

    it('uses chatIdOverride as first priority', () => {
      store.currentChatId = 'chat-current';
      store.addArtifact({ id: 'a1', chatId: 'chat-artifact' }, 'chat-override');
      expect(store.sessions.has('chat-override')).toBe(true);
      expect(store.sessions.has('chat-artifact')).toBe(false);
      expect(store.sessions.has('chat-current')).toBe(false);
    });

    it('uses artifact.chatId as second priority', () => {
      store.currentChatId = 'chat-current';
      store.addArtifact({ id: 'a1', chatId: 'chat-artifact' });
      expect(store.sessions.has('chat-artifact')).toBe(true);
      expect(store.sessions.has('chat-current')).toBe(false);
    });

    it('uses currentChatId as third priority', () => {
      store.currentChatId = 'chat-current';
      store.addArtifact({ id: 'a1' });
      expect(store.sessions.has('chat-current')).toBe(true);
    });

    it('creates session Map for new chatId', () => {
      store.addArtifact({ id: 'a1' }, 'chat-new');
      expect(store.sessions.has('chat-new')).toBe(true);
      expect(store.sessions.get('chat-new')).toBeInstanceOf(Map);
    });

    it('stores artifact clone (not reference) in session', () => {
      const original = { id: 'a1', content: 'original' };
      store.addArtifact(original, 'chat-1');

      // Mutate original — should NOT affect stored copy
      original.content = 'mutated';

      const stored = store.sessions.get('chat-1').get('a1');
      expect(stored.content).toBe('original');
    });

    it('overwrites artifact with same id', () => {
      store.addArtifact({ id: 'a1', content: 'v1' }, 'chat-1');
      store.addArtifact({ id: 'a1', content: 'v2' }, 'chat-1');

      const stored = store.sessions.get('chat-1').get('a1');
      expect(stored.content).toBe('v2');
      expect(store.sessions.get('chat-1').size).toBe(1);
    });

    it('adds multiple artifacts to same session', () => {
      store.addArtifact({ id: 'a1' }, 'chat-1');
      store.addArtifact({ id: 'a2' }, 'chat-1');
      store.addArtifact({ id: 'a3' }, 'chat-1');

      expect(store.sessions.get('chat-1').size).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getArtifact()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getArtifact()', () => {
    it('returns null when artifactId is null', () => {
      expect(store.getArtifact(null)).toBeNull();
    });

    it('returns null when artifactId is undefined', () => {
      expect(store.getArtifact(undefined)).toBeNull();
    });

    it('returns null when artifactId is empty string', () => {
      expect(store.getArtifact('')).toBeNull();
    });

    it('returns null when no chatId can be resolved', () => {
      // No override, no currentChatId
      expect(store.getArtifact('a1')).toBeNull();
    });

    it('returns null when chatId has no session', () => {
      store.currentChatId = 'chat-nonexistent';
      expect(store.getArtifact('a1')).toBeNull();
    });

    it('returns null when artifact does not exist in session', () => {
      store.addArtifact({ id: 'a1' }, 'chat-1');
      store.currentChatId = 'chat-1';
      expect(store.getArtifact('a-missing')).toBeNull();
    });

    it('returns artifact by id using currentChatId', () => {
      store.addArtifact({ id: 'a1', content: 'hello' }, 'chat-1');
      store.currentChatId = 'chat-1';

      const result = store.getArtifact('a1');
      expect(result).not.toBeNull();
      expect(result.id).toBe('a1');
      expect(result.content).toBe('hello');
    });

    it('uses chatIdOverride over currentChatId', () => {
      store.addArtifact({ id: 'a1', content: 'in-chat-2' }, 'chat-2');
      store.currentChatId = 'chat-1';

      // a1 is in chat-2, not chat-1
      expect(store.getArtifact('a1')).toBeNull(); // uses currentChatId=chat-1

      const result = store.getArtifact('a1', 'chat-2');
      expect(result).not.toBeNull();
      expect(result.content).toBe('in-chat-2');
    });

    it('returns null when chatIdOverride session does not exist', () => {
      store.addArtifact({ id: 'a1' }, 'chat-1');
      expect(store.getArtifact('a1', 'chat-other')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // cacheArtifacts()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('cacheArtifacts()', () => {
    it('does nothing when chatId is null', () => {
      store.cacheArtifacts(null, [{ id: 'a1' }]);
      expect(store.sessions.size).toBe(0);
    });

    it('does nothing when chatId is undefined', () => {
      store.cacheArtifacts(undefined, [{ id: 'a1' }]);
      expect(store.sessions.size).toBe(0);
    });

    it('does nothing when chatId is empty string', () => {
      store.cacheArtifacts('', [{ id: 'a1' }]);
      expect(store.sessions.size).toBe(0);
    });

    it('creates session with empty Map when artifacts array is empty', () => {
      store.cacheArtifacts('chat-1', []);
      expect(store.sessions.has('chat-1')).toBe(true);
      expect(store.sessions.get('chat-1').size).toBe(0);
    });

    it('creates session with default empty array when artifacts is undefined', () => {
      store.cacheArtifacts('chat-1');
      expect(store.sessions.has('chat-1')).toBe(true);
      expect(store.sessions.get('chat-1').size).toBe(0);
    });

    it('caches multiple artifacts at once', () => {
      const artifacts = [
        { id: 'a1', type: 'code' },
        { id: 'a2', type: 'output' },
        { id: 'a3', type: 'html' },
      ];
      store.cacheArtifacts('chat-1', artifacts);

      const session = store.sessions.get('chat-1');
      expect(session.size).toBe(3);
      expect(session.get('a1').type).toBe('code');
      expect(session.get('a2').type).toBe('output');
      expect(session.get('a3').type).toBe('html');
    });

    it('replaces existing session entirely', () => {
      store.addArtifact({ id: 'old-1', content: 'old' }, 'chat-1');
      store.addArtifact({ id: 'old-2', content: 'old' }, 'chat-1');

      store.cacheArtifacts('chat-1', [{ id: 'new-1', content: 'new' }]);

      const session = store.sessions.get('chat-1');
      expect(session.size).toBe(1);
      expect(session.has('old-1')).toBe(false);
      expect(session.has('old-2')).toBe(false);
      expect(session.get('new-1').content).toBe('new');
    });

    it('filters out null artifacts', () => {
      store.cacheArtifacts('chat-1', [null, { id: 'a1' }, null]);
      expect(store.sessions.get('chat-1').size).toBe(1);
    });

    it('filters out artifacts without id', () => {
      store.cacheArtifacts('chat-1', [
        { id: 'a1' },
        { content: 'no-id' },
        { id: '', content: 'empty-id' },
      ]);
      // Only a1 has a truthy id
      // '' is falsy, so it gets filtered
      expect(store.sessions.get('chat-1').size).toBe(1);
      expect(store.sessions.get('chat-1').has('a1')).toBe(true);
    });

    it('stores clones, not references', () => {
      const original = { id: 'a1', content: 'original' };
      store.cacheArtifacts('chat-1', [original]);

      original.content = 'mutated';

      const stored = store.sessions.get('chat-1').get('a1');
      expect(stored.content).toBe('original');
    });

    it('deduplicates artifacts with same id (last wins)', () => {
      store.cacheArtifacts('chat-1', [
        { id: 'a1', content: 'first' },
        { id: 'a1', content: 'second' },
      ]);

      const session = store.sessions.get('chat-1');
      expect(session.size).toBe(1);
      expect(session.get('a1').content).toBe('second');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Integration: Full lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  describe('full lifecycle', () => {
    it('init -> addArtifact -> switchSession -> getArtifact -> cacheArtifacts', async () => {
      // Init
      await store.init();

      // Add artifacts to chat-1
      store.addArtifact({ id: 'a1', content: 'code' }, 'chat-1');
      store.addArtifact({ id: 'a2', content: 'output' }, 'chat-1');

      // Switch to chat-1
      const session = await store.switchSession('chat-1');
      expect(session.artifacts).toHaveLength(2);

      // Get individual artifact
      const art = store.getArtifact('a1');
      expect(art.content).toBe('code');

      // Bulk cache replaces session
      store.cacheArtifacts('chat-1', [{ id: 'b1', content: 'cached' }]);
      const after = store.getSessionArtifacts('chat-1');
      expect(after.artifacts).toHaveLength(1);
      expect(after.artifacts[0].id).toBe('b1');

      // Old artifacts are gone
      expect(store.getArtifact('a1')).toBeNull();
    });

    it('multiple sessions with isolated state', () => {
      store.addArtifact({ id: 'c1-a1', content: 'chat1-art1' }, 'chat-1');
      store.addArtifact({ id: 'c2-a1', content: 'chat2-art1' }, 'chat-2');
      store.addArtifact({ id: 'c2-a2', content: 'chat2-art2' }, 'chat-2');

      expect(store.getSessionArtifacts('chat-1').artifacts).toHaveLength(1);
      expect(store.getSessionArtifacts('chat-2').artifacts).toHaveLength(2);
      expect(store.getSessionArtifacts('chat-3').artifacts).toHaveLength(0);
    });
  });
});
