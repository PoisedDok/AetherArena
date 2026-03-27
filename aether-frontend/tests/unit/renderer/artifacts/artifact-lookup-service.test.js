'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const { ArtifactLookupService } = require(
  '../../../../src/renderer/artifacts/controllers/modules/ArtifactLookupService'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createArtifactCache(initial = []) {
  const map = new Map();
  initial.forEach(a => map.set(a.id, a));
  return map;
}

function createIndexService() {
  const store = new Map(); // indexKey -> Map<variantKey, artifactId>
  return {
    track: jest.fn((indexKey, variantKey, artifactId) => {
      if (!store.has(indexKey)) store.set(indexKey, new Map());
      store.get(indexKey).set(variantKey, artifactId);
    }),
    getVariants: jest.fn((indexKey) => store.get(indexKey) || null),
    clear: jest.fn(() => store.clear()),
    _store: store,
  };
}

function createSessionStore(sessionArtifacts = []) {
  const artifactMap = new Map();
  sessionArtifacts.forEach(a => artifactMap.set(a.id, a));
  return {
    getArtifact: jest.fn((id) => artifactMap.get(id) || null),
    getSessionArtifacts: jest.fn(() => ({ artifacts: sessionArtifacts })),
  };
}

function createService(overrides = {}) {
  const cache = overrides.cache || createArtifactCache();
  const indexService = overrides.indexService || createIndexService();
  const sessionStore = overrides.sessionStore || createSessionStore();
  const deleted = overrides.deleted || new Set();
  const loadArtifact = overrides.loadArtifact || jest.fn();
  const switchTab = overrides.switchTab || jest.fn();
  const showDeletedMessage = overrides.showDeletedMessage || jest.fn();
  const currentChatId = overrides.currentChatId || 'chat-001';

  return {
    service: new ArtifactLookupService({
      getArtifactCache: () => cache,
      getArtifactIndexService: () => indexService,
      getSessionStore: () => sessionStore,
      getCurrentChatId: () => currentChatId,
      getDeletedArtifacts: () => deleted,
      loadArtifact,
      switchTab,
      showDeletedMessage,
    }),
    cache,
    indexService,
    sessionStore,
    deleted,
    loadArtifact,
    switchTab,
    showDeletedMessage,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactLookupService', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  // =========================================================================
  // handleShowArtifact
  // =========================================================================

  describe('handleShowArtifact', () => {
    it('loads artifact from cache when found', () => {
      const artifact = { id: 'art-1', role: 'assistant', type: 'code', request_id: 'req-1' };
      const { service, loadArtifact, switchTab, showDeletedMessage } = createService({
        cache: createArtifactCache([artifact]),
      });

      service.handleShowArtifact({ artifactId: 'art-1', tab: 'code' });

      expect(switchTab).toHaveBeenCalledWith('code');
      expect(loadArtifact).toHaveBeenCalledWith(artifact, {
        autoSwitch: false,
        origin: 'manual',
        isFinal: true,
      });
      expect(showDeletedMessage).not.toHaveBeenCalled();
    });

    it('auto-switches when no tab specified', () => {
      const artifact = { id: 'art-1', role: 'assistant', type: 'code', request_id: 'req-1' };
      const { service, loadArtifact, switchTab } = createService({
        cache: createArtifactCache([artifact]),
      });

      service.handleShowArtifact({ artifactId: 'art-1' });

      expect(switchTab).not.toHaveBeenCalled();
      expect(loadArtifact).toHaveBeenCalledWith(artifact, expect.objectContaining({
        autoSwitch: true,
      }));
    });

    it('shows deleted message when artifact is in deletedArtifacts set', () => {
      const artifact = { id: 'art-1', role: 'assistant', type: 'code', request_id: 'req-1' };
      const deleted = new Set(['art-1']);
      const { service, loadArtifact, showDeletedMessage } = createService({
        cache: createArtifactCache([artifact]),
        deleted,
      });

      service.handleShowArtifact({ artifactId: 'art-1', tab: 'code' });

      expect(showDeletedMessage).toHaveBeenCalledWith('art-1');
      expect(loadArtifact).not.toHaveBeenCalled();
    });

    it('deleted check runs BEFORE session store fallback (no cache pollution)', () => {
      const sessionArtifact = { id: 'sess-1', role: 'assistant', type: 'code', request_id: 'req-s' };
      const deleted = new Set(['sess-1']);
      const { service, cache, showDeletedMessage, loadArtifact } = createService({
        sessionStore: createSessionStore([sessionArtifact]),
        deleted,
      });

      service.handleShowArtifact({ artifactId: 'sess-1' });

      // Must show deleted, NOT add to cache
      expect(showDeletedMessage).toHaveBeenCalledWith('sess-1');
      expect(loadArtifact).not.toHaveBeenCalled();
      expect(cache.has('sess-1')).toBe(false);
    });

    it('shows deleted message when artifact not found anywhere', () => {
      const { service, showDeletedMessage, loadArtifact } = createService();

      service.handleShowArtifact({ artifactId: 'nonexistent' });

      expect(showDeletedMessage).toHaveBeenCalledWith('nonexistent');
      expect(loadArtifact).not.toHaveBeenCalled();
    });

    it('finds artifact from session store when not in cache or index', () => {
      const artifact = { id: 'art-session', role: 'assistant', type: 'code', request_id: 'req-s' };
      const { service, cache, loadArtifact } = createService({
        sessionStore: createSessionStore([artifact]),
      });

      service.handleShowArtifact({ artifactId: 'art-session' });

      // Should be added to cache after being found in session
      expect(cache.has('art-session')).toBe(true);
      expect(loadArtifact).toHaveBeenCalledWith(artifact, expect.any(Object));
    });

    it('catches and logs errors without throwing', () => {
      const { service } = createService();
      // Force error by making getArtifactCache throw
      service.getArtifactCache = () => { throw new Error('Boom'); };

      expect(() => service.handleShowArtifact({ artifactId: 'x' })).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Handle show artifact failed',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // primeArtifactCache
  // =========================================================================

  describe('primeArtifactCache', () => {
    it('clears cache and index then populates with new artifacts', () => {
      const { service, cache, indexService } = createService({
        cache: createArtifactCache([{ id: 'old', role: 'assistant', type: 'code', request_id: 'old-req' }]),
      });

      const artifacts = [
        { id: 'a1', role: 'assistant', type: 'code', request_id: 'req-1' },
        { id: 'a2', role: 'computer', type: 'output', request_id: 'req-2' },
      ];

      const hasContent = service.primeArtifactCache(artifacts);

      expect(hasContent).toBe(true);
      expect(cache.size).toBe(2);
      expect(cache.has('a1')).toBe(true);
      expect(cache.has('a2')).toBe(true);
      expect(cache.has('old')).toBe(false);
      expect(indexService.clear).toHaveBeenCalled();
      expect(indexService.track).toHaveBeenCalledTimes(2);
    });

    it('returns false for empty array', () => {
      const { service } = createService();
      expect(service.primeArtifactCache([])).toBe(false);
    });

    it('returns false for undefined', () => {
      const { service } = createService();
      expect(service.primeArtifactCache()).toBe(false);
    });

    it('skips null and id-less artifacts', () => {
      const { service, cache } = createService();

      service.primeArtifactCache([null, {}, { id: 'valid', role: 'assistant', type: 'code', request_id: 'req-v' }]);

      expect(cache.size).toBe(1);
      expect(cache.has('valid')).toBe(true);
    });

    it('returns false when ALL artifacts are null/invalid (regression: false positive)', () => {
      const { service, cache } = createService();

      const result = service.primeArtifactCache([null, null, {}]);

      expect(result).toBe(false);
      expect(cache.size).toBe(0);
    });
  });

  // =========================================================================
  // trackBackendIndex
  // =========================================================================

  describe('trackBackendIndex', () => {
    it('tracks by executionGroup when present', () => {
      const { service, indexService } = createService();

      service.trackBackendIndex({
        id: 'a1',
        executionGroup: 'exec-group-1',
        role: 'assistant',
        type: 'code',
        request_id: 'req-1',
      });

      expect(indexService.track).toHaveBeenCalledWith('exec-group-1', 'assistant:code', 'a1');
    });

    it('falls back to request_id when no executionGroup', () => {
      const { service, indexService } = createService();

      service.trackBackendIndex({
        id: 'a2',
        role: 'computer',
        type: 'output',
        request_id: 'req-fallback',
      });

      expect(indexService.track).toHaveBeenCalledWith('req-fallback', 'computer:output', 'a2');
    });

    it('uses variantKeyOverride when provided', () => {
      const { service, indexService } = createService();

      service.trackBackendIndex(
        { id: 'a3', role: 'assistant', type: 'code', request_id: 'req-3' },
        'custom:variant'
      );

      expect(indexService.track).toHaveBeenCalledWith('req-3', 'custom:variant', 'a3');
    });

    it('throws CONTRACT VIOLATION when request_id is missing and no executionGroup', () => {
      const { service } = createService();

      expect(() => service.trackBackendIndex({ id: 'bad', role: 'assistant', type: 'code' }))
        .toThrow('CONTRACT VIOLATION');
    });
  });

  // =========================================================================
  // Variant selection logic
  // =========================================================================

  describe('variant selection', () => {
    it('selects assistant:code for code tab priority', () => {
      const indexService = createIndexService();
      const codeArtifact = { id: 'code-1', role: 'assistant', type: 'code', request_id: 'req-1' };
      const outputArtifact = { id: 'out-1', role: 'computer', type: 'output', request_id: 'req-1' };
      const cache = createArtifactCache([codeArtifact, outputArtifact]);

      // Track both variants under same index key
      indexService.track('req-1', 'assistant:code', 'code-1');
      indexService.track('req-1', 'computer:output', 'out-1');

      const { service, loadArtifact } = createService({ cache, indexService });

      service.handleShowArtifact({ artifactId: 'req-1', tab: 'code' });

      expect(loadArtifact).toHaveBeenCalledWith(codeArtifact, expect.any(Object));
    });

    it('selects computer:output for output tab priority', () => {
      const indexService = createIndexService();
      const codeArtifact = { id: 'code-1', role: 'assistant', type: 'code', request_id: 'req-1' };
      const outputArtifact = { id: 'out-1', role: 'computer', type: 'output', request_id: 'req-1' };
      const cache = createArtifactCache([codeArtifact, outputArtifact]);

      indexService.track('req-1', 'assistant:code', 'code-1');
      indexService.track('req-1', 'computer:output', 'out-1');

      const { service, loadArtifact } = createService({ cache, indexService });

      service.handleShowArtifact({ artifactId: 'req-1', tab: 'output' });

      expect(loadArtifact).toHaveBeenCalledWith(outputArtifact, expect.any(Object));
    });

    it('falls back to default priority when tab is null', () => {
      const indexService = createIndexService();
      const codeArtifact = { id: 'code-1', role: 'assistant', type: 'code', request_id: 'req-1' };
      const cache = createArtifactCache([codeArtifact]);

      indexService.track('req-1', 'assistant:code', 'code-1');

      const { service, loadArtifact } = createService({ cache, indexService });

      // artifactId matches index key, no tab → default priority (assistant:code is first)
      service.handleShowArtifact({ artifactId: 'req-1' });

      expect(loadArtifact).toHaveBeenCalledWith(codeArtifact, expect.any(Object));
    });

    it('falls back to first variant entry when no priority matches', () => {
      const indexService = createIndexService();
      // Use a variant key that doesn't match any priority list
      const artifact = { id: 'custom-1', role: 'tool', type: 'diagram', request_id: 'req-1' };
      const cache = createArtifactCache([artifact]);

      indexService.track('req-1', 'tool:diagram', 'custom-1');

      const { service, loadArtifact } = createService({ cache, indexService });

      // tab=console priority list won't match 'tool:diagram', should fallback to first
      service.handleShowArtifact({ artifactId: 'req-1', tab: 'console' });

      expect(loadArtifact).toHaveBeenCalledWith(artifact, expect.any(Object));
    });

    it('uses console tab variant priority correctly', () => {
      const indexService = createIndexService();
      const consoleArtifact = { id: 'con-1', role: 'computer', type: 'console', request_id: 'req-1' };
      const codeArtifact = { id: 'code-1', role: 'assistant', type: 'code', request_id: 'req-1' };
      const cache = createArtifactCache([consoleArtifact, codeArtifact]);

      indexService.track('req-1', 'computer:console', 'con-1');
      indexService.track('req-1', 'assistant:code', 'code-1');

      const { service, loadArtifact } = createService({ cache, indexService });

      service.handleShowArtifact({ artifactId: 'req-1', tab: 'console' });

      // Console priority: computer:console first
      expect(loadArtifact).toHaveBeenCalledWith(consoleArtifact, expect.any(Object));
    });
  });

  // =========================================================================
  // Session scan fallback
  // =========================================================================

  describe('session scan fallback', () => {
    it('finds artifact from session when index has no match in cache', () => {
      const sessionArtifact = {
        id: 'sess-art',
        role: 'assistant',
        type: 'code',
        request_id: 'exec-key',
        executionGroup: 'exec-key',
      };

      const { service, cache, loadArtifact } = createService({
        sessionStore: createSessionStore([sessionArtifact]),
        currentChatId: 'chat-001',
      });

      service.handleShowArtifact({ artifactId: 'exec-key', tab: 'code' });

      expect(cache.has('sess-art')).toBe(true);
      expect(loadArtifact).toHaveBeenCalledWith(sessionArtifact, expect.any(Object));
    });

    it('returns null when no currentChatId for session scan', () => {
      const { service, showDeletedMessage } = createService({
        currentChatId: null,
      });

      service.handleShowArtifact({ artifactId: 'missing' });

      expect(showDeletedMessage).toHaveBeenCalledWith('missing');
    });
  });

  // =========================================================================
  // _getRequestIdFromArtifact CONTRACT
  // =========================================================================

  describe('CONTRACT: _getRequestIdFromArtifact', () => {
    it('throws when artifact is null', () => {
      const { service } = createService();
      expect(() => service._getRequestIdFromArtifact(null))
        .toThrow('CONTRACT VIOLATION: artifact is required');
    });

    it('throws when request_id is missing', () => {
      const { service } = createService();
      expect(() => service._getRequestIdFromArtifact({ id: 'a1' }))
        .toThrow('CONTRACT VIOLATION: artifact.request_id is required');
    });

    it('reads request_id from metadata fallback', () => {
      const { service } = createService();
      const result = service._getRequestIdFromArtifact({
        id: 'a1',
        metadata: { request_id: 'meta-req' },
      });
      expect(result).toBe('meta-req');
    });
  });

  // =========================================================================
  // _artifactRole
  // =========================================================================

  describe('_artifactRole', () => {
    it('returns role from artifact.role', () => {
      const { service } = createService();
      expect(service._artifactRole({ role: 'Computer' })).toBe('computer');
    });

    it('falls back to metadata.role', () => {
      const { service } = createService();
      expect(service._artifactRole({ metadata: { role: 'Assistant' } })).toBe('assistant');
    });

    it('defaults to assistant when no role anywhere', () => {
      const { service } = createService();
      expect(service._artifactRole({})).toBe('assistant');
    });

    it('handles null artifact gracefully', () => {
      const { service } = createService();
      expect(service._artifactRole(null)).toBe('assistant');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('nulls all references', () => {
      const { service } = createService();
      service.dispose();

      expect(service.getArtifactCache).toBeNull();
      expect(service.getArtifactIndexService).toBeNull();
      expect(service.getSessionStore).toBeNull();
      expect(service.getCurrentChatId).toBeNull();
      expect(service.getDeletedArtifacts).toBeNull();
      expect(service.loadArtifact).toBeNull();
      expect(service.switchTab).toBeNull();
      expect(service.showDeletedMessage).toBeNull();
    });
  });
});
