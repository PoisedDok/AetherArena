'use strict';

/**
 * @.architecture
 *
 * Incoming: IPC onShowArtifact events, controller calls for cache priming/index tracking --- {ipc.custom | method_call, object}
 * Processing: Multi-strategy artifact lookup (cache → index → session), variant selection by tab priority --- {5 jobs: JOB_CACHE_LOOKUP, JOB_INDEX_LOOKUP, JOB_SESSION_SCAN, JOB_VARIANT_SELECT, JOB_CACHE_PRIME}
 * Outgoing: Resolved artifact to controller.loadArtifact / controller.switchTab, or deleted-artifact message --- {method_call, object|void}
 *
 * @module renderer/artifacts/controllers/modules/ArtifactLookupService
 *
 * ArtifactLookupService - Artifact Resolution & Variant Selection
 * ============================================================================
 * Extracted from ArtifactsController monolith. Owns the multi-strategy
 * artifact lookup pipeline and variant priority logic.
 *
 * SINGLE RESPONSIBILITY: Given an artifact ID + tab hint, resolve the best
 * matching artifact from cache, index service, or session store.
 */

const { getArtifactVariantKey } = require('../../../shared/contracts/artifactStream');
const { createRendererLogger } = require('../../../shared/utils/logger');

const logger = createRendererLogger('ArtifactLookupService');

const TAB_VARIANT_PRIORITY = {
  code: ['assistant:code', 'assistant:html', 'computer:code'],
  output: ['computer:output', 'computer:code', 'computer:html', 'assistant:code'],
  console: ['computer:console', 'computer:output', 'assistant:code']
};

const DEFAULT_VARIANT_PRIORITY = ['assistant:code', 'computer:output', 'computer:console'];

class ArtifactLookupService {
  /**
   * @param {Object} options
   * @param {Function} options.getArtifactCache        - () => Map-like cache
   * @param {Function} options.getArtifactIndexService  - () => ArtifactIndexService
   * @param {Function} options.getSessionStore          - () => ArtifactSessionStore
   * @param {Function} options.getCurrentChatId         - () => string|null
   * @param {Function} options.getDeletedArtifacts      - () => Set<string>
   * @param {Function} options.loadArtifact             - (artifact, opts) => void
   * @param {Function} options.switchTab                - (tab) => void
   * @param {Function} options.showDeletedMessage       - (artifactId) => void
   */
  constructor(options = {}) {
    this.getArtifactCache = options.getArtifactCache;
    this.getArtifactIndexService = options.getArtifactIndexService;
    this.getSessionStore = options.getSessionStore;
    this.getCurrentChatId = options.getCurrentChatId;
    this.getDeletedArtifacts = options.getDeletedArtifacts;
    this.loadArtifact = options.loadArtifact;
    this.switchTab = options.switchTab;
    this.showDeletedMessage = options.showDeletedMessage;
    this._isDisposed = false;

    this.log = logger.child({ scope: 'lookup-service' });
    this.log.debug('ArtifactLookupService initialized');
  }

  /**
   * Handle show artifact request (from trail nodes via IPC).
   * Multi-strategy resolution: cache → index → session.
   *
   * @param {Object} data
   * @param {string} data.artifactId
   * @param {string} [data.tab]
   */
  handleShowArtifact(data) {
    if (this._isDisposed) return;
    try {
      const { artifactId, tab } = data;
      const artifactCache = this.getArtifactCache();
      const sessionStore = this.getSessionStore();
      const deletedArtifacts = this.getDeletedArtifacts();

      this.log.debug('Show artifact requested', { artifactId, tab });

      // Check if artifact was deleted FIRST — before any cache/session lookups
      // that would pollute the cache with a deleted artifact reference.
      if (deletedArtifacts.has(artifactId)) {
        this.log.warn('Artifact has been deleted', { artifactId, tab });
        this.showDeletedMessage(artifactId);
        return;
      }

      let artifact = artifactCache.get(artifactId);

      if (!artifact) {
        artifact = this._findArtifactByBackend(artifactId, tab);
      }

      if (!artifact) {
        artifact = sessionStore.getArtifact(artifactId);
        if (artifact) {
          artifactCache.set(artifact.id, artifact);
          this.trackBackendIndex(artifact);
        }
      }

      if (artifact) {
        // If a specific tab was requested, switch to it first
        if (tab) {
          this.log.trace('Switching tab to display artifact', { tab });
          this.switchTab(tab);
        }
        this.loadArtifact(artifact, {
          autoSwitch: !tab,
          origin: 'manual',
          isFinal: true
        });
      } else {
        this.log.warn('Requested artifact not found', { artifactId, tab });
        this.showDeletedMessage(artifactId);
      }
    } catch (error) {
      this.log.error('Handle show artifact failed', { error, data });
    }
  }

  /**
   * Prime the artifact cache with a list of artifacts (e.g. after chat switch).
   * Clears existing cache and index, then populates both.
   *
   * @param {Array} artifacts
   */
  primeArtifactCache(artifacts = []) {
    if (this._isDisposed) return false;
    const artifactCache = this.getArtifactCache();
    const artifactIndexService = this.getArtifactIndexService();

    artifactCache.clear();
    artifactIndexService.clear();

    let cachedCount = 0;
    artifacts.forEach((artifact) => {
      if (!artifact || !artifact.id) {
        return;
      }
      artifactCache.set(artifact.id, artifact);
      this.trackBackendIndex(artifact);
      cachedCount++;
    });

    // Return whether content actually exists (caller sets hasContent)
    return cachedCount > 0;
  }

  /**
   * Track an artifact in the backend index service for variant lookup.
   *
   * @param {Object} artifact
   * @param {string|null} [variantKeyOverride]
   */
  trackBackendIndex(artifact, variantKeyOverride = null) {
    if (this._isDisposed) return;
    const artifactIndexService = this.getArtifactIndexService();

    // ARCHITECTURAL FIX: Use executionGroup as the primary indexing key for variants.
    // Multiple executions within the same request (requestId) must not clobber each other.
    const indexKey = artifact.executionGroup || this._getRequestIdFromArtifact(artifact);

    if (!indexKey) {
      return;
    }

    const variantKey = variantKeyOverride || getArtifactVariantKey(this._artifactRole(artifact), artifact.type);
    artifactIndexService.track(indexKey, variantKey, artifact.id);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────

  _findArtifactByBackend(indexKey, tab) {
    if (!indexKey) {
      return null;
    }

    const artifactIndexService = this.getArtifactIndexService();
    const artifactCache = this.getArtifactCache();

    const variantMap = artifactIndexService.getVariants(indexKey);
    if (variantMap) {
      const variantId = this._selectVariantFromMap(variantMap, tab);
      if (variantId && artifactCache.has(variantId)) {
        return artifactCache.get(variantId);
      }
    }

    return this._scanSessionArtifactsByBackend(indexKey, tab);
  }

  _selectVariantFromMap(variantMap, tab) {
    const priorities = this._getVariantPriority(tab);
    for (const priority of priorities) {
      if (variantMap.has(priority)) {
        return variantMap.get(priority);
      }
    }

    // Fallback to first entry
    for (const id of variantMap.values()) {
      return id;
    }
    return null;
  }

  _scanSessionArtifactsByBackend(indexKey, tab) {
    const currentChatId = this.getCurrentChatId();
    if (!currentChatId) {
      return null;
    }

    const sessionStore = this.getSessionStore();
    const artifactCache = this.getArtifactCache();

    const sessionData = sessionStore.getSessionArtifacts(currentChatId);
    const candidates = sessionData?.artifacts?.filter(
      (artifact) => (artifact.executionGroup || this._getRequestIdFromArtifact(artifact)) === indexKey
    ) || [];

    if (candidates.length === 0) {
      return null;
    }

    const selected = this._selectArtifactCandidate(candidates, tab);
    if (selected) {
      artifactCache.set(selected.id, selected);
      this.trackBackendIndex(selected);
    }
    return selected;
  }

  _selectArtifactCandidate(candidates, tab) {
    const priorities = this._getVariantPriority(tab);

    for (const priority of priorities) {
      const match = candidates.find(
        (artifact) => getArtifactVariantKey(this._artifactRole(artifact), artifact.type) === priority
      );
      if (match) {
        return match;
      }
    }

    return candidates[0] || null;
  }

  _getRequestIdFromArtifact(artifact) {
    if (!artifact) {
      throw new Error('[ArtifactLookupService] CONTRACT VIOLATION: artifact is required');
    }
    const requestId = artifact.request_id || artifact.metadata?.request_id;
    if (!requestId || typeof requestId !== 'string') {
      throw new Error(`[ArtifactLookupService] CONTRACT VIOLATION: artifact.request_id is required. artifactId=${artifact.id || artifact.artifactId || 'unknown'}`);
    }
    return requestId;
  }

  _artifactRole(artifact) {
    return (artifact?.role || artifact?.metadata?.role || 'assistant').toLowerCase();
  }

  _getVariantPriority(tab) {
    const tabKey = typeof tab === 'string' ? tab.toLowerCase() : null;
    if (tabKey && TAB_VARIANT_PRIORITY[tabKey]) {
      return TAB_VARIANT_PRIORITY[tabKey];
    }
    return DEFAULT_VARIANT_PRIORITY;
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    // Null out references
    this.getArtifactCache = null;
    this.getArtifactIndexService = null;
    this.getSessionStore = null;
    this.getCurrentChatId = null;
    this.getDeletedArtifacts = null;
    this.loadArtifact = null;
    this.switchTab = null;
    this.showDeletedMessage = null;
    this.log.debug('ArtifactLookupService disposed');
  }
}

module.exports = { ArtifactLookupService };
