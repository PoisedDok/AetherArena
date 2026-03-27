'use strict';

/**
 * @.architecture
 * Incoming: SettingsManager (delegation) for populate/collect/lock/refresh of local sources settings --- {settings_section, javascript_object}
 * Processing: Bind local sources config (search weights/modes, root dir) to DOM inputs, collect back, refresh status --- {5 jobs: JOB_POPULATE, JOB_COLLECT, JOB_LOCK, JOB_REFRESH}
 * Outgoing: DOM mutations, endpoint calls (setSettings, getSources) --- {dom_mutation | http_request, void | json}
 *
 * @module application/main/modules/settings/binders/LocalSourcesBinder
 */

const config = require('../../../../../core/config');

class LocalSourcesBinder {
  /**
   * @param {Object} deps
   * @param {Object} deps.log - Logger instance
   * @param {Object} [deps.endpoint] - Backend endpoint
   */
  constructor(deps = {}) {
    this._log = deps.log || { info() {}, warn() {}, error() {} };
    this._endpoint = deps.endpoint || null;
    this._listeners = [];
  }

  _trackListener(el, event, handler) {
    if (!el) return;
    el.addEventListener(event, handler);
    this._listeners.push({ el, event, handler });
  }

  dispose() {
    for (const { el, event, handler } of this._listeners) {
      el.removeEventListener(event, handler);
    }
    this._listeners = [];
    this._endpoint = null;
  }

  set endpoint(v) { this._endpoint = v; }

  // =========================================================================
  // Populate
  // =========================================================================

  async populate(localSources) {
    const cfg = localSources && typeof localSources === 'object' ? localSources : {};

    const searchModeEl = document.getElementById('aether-rag-search-mode');
    const searchSemanticWeightEl = document.getElementById('aether-rag-search-semantic-weight');
    const searchSparseWeightEl = document.getElementById('aether-rag-search-sparse-weight');
    const searchRrfKEl = document.getElementById('aether-rag-search-rrf-k');
    const searchHybridSettingsEl = document.getElementById('aether-rag-search-hybrid-settings');

    const search = cfg.search || {};
    if (searchModeEl && typeof search.mode === 'string') {
      searchModeEl.value = search.mode;
      if (searchHybridSettingsEl) {
        searchHybridSettingsEl.style.display = search.mode === 'hybrid' ? 'flex' : 'none';
      }
    }
    if (searchSemanticWeightEl && search.hybrid_semantic_weight !== undefined) searchSemanticWeightEl.value = String(search.hybrid_semantic_weight);
    if (searchSparseWeightEl && search.hybrid_sparse_weight !== undefined) searchSparseWeightEl.value = String(search.hybrid_sparse_weight);
    if (searchRrfKEl && search.rrf_k !== undefined) searchRrfKEl.value = String(search.rrf_k);

    const enabledEl = document.getElementById('aether-rag-sources-enabled');
    const indexRootEl = document.getElementById('aether-rag-sources-index-root-dir');

    if (enabledEl) enabledEl.checked = Boolean(cfg.enabled);
    if (indexRootEl && typeof cfg.index_root_dir === 'string') indexRootEl.value = cfg.index_root_dir;
  }

  // =========================================================================
  // Collect
  // =========================================================================

  collect() {
    const searchModeEl = document.getElementById('aether-rag-search-mode');
    const searchSemanticWeightEl = document.getElementById('aether-rag-search-semantic-weight');
    const searchSparseWeightEl = document.getElementById('aether-rag-search-sparse-weight');
    const searchRrfKEl = document.getElementById('aether-rag-search-rrf-k');

    const enabledEl = document.getElementById('aether-rag-sources-enabled');
    const indexRootEl = document.getElementById('aether-rag-sources-index-root-dir');

    // If UI not present, don't emit anything.
    if (!enabledEl) {
      return null;
    }

    return {
      enabled: Boolean(enabledEl.checked),
      index_root_dir: LocalSourcesBinder._sanitize(indexRootEl?.value) || undefined,
      search: {
        mode: LocalSourcesBinder._sanitize(searchModeEl?.value) || 'hybrid',
        hybrid_semantic_weight: searchSemanticWeightEl ? parseFloat(searchSemanticWeightEl.value) : 1.0,
        hybrid_sparse_weight: searchSparseWeightEl ? parseFloat(searchSparseWeightEl.value) : 0.5,
        rrf_k: searchRrfKEl ? parseInt(searchRrfKEl.value, 10) : 60,
      }
    };
  }

  // =========================================================================
  // Lock
  // =========================================================================

  lockControls(reason = 'Disabled by backend configuration') {
    const ids = [
      'aether-rag-search-mode', 'aether-rag-search-semantic-weight', 'aether-rag-search-sparse-weight', 'aether-rag-search-rrf-k',
      'aether-rag-sources-enabled', 'aether-rag-sources-index-root-dir', 'aether-rag-sources-refresh'
    ];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = true;
      el.title = reason;
    });
  }

  // =========================================================================
  // Attach listeners (one-time)
  // =========================================================================

  attachListenersOnce() {
    const searchModeEl = document.getElementById('aether-rag-search-mode');
    if (searchModeEl && !searchModeEl.dataset.listenerAdded) {
      this._trackListener(searchModeEl, 'change', (e) => {
        const hybridSettings = document.getElementById('aether-rag-search-hybrid-settings');
        if (hybridSettings) {
          hybridSettings.style.display = e.target.value === 'hybrid' ? 'flex' : 'none';
        }
      });
      searchModeEl.dataset.listenerAdded = 'true';
    }

    const refreshBtn = document.getElementById('aether-rag-sources-refresh');
    if (refreshBtn && !refreshBtn.dataset.listenerAdded) {
      this._trackListener(refreshBtn, 'click', async () => {
        try {
          await this.refreshStatus();
        } catch (error) {
          this._log.error('[LocalSourcesBinder] Failed to refresh sources:', error);
          LocalSourcesBinder._setText('aether-rag-sources-status', `Failed to load sources: ${error.message}`);
        }
      });
      refreshBtn.dataset.listenerAdded = 'true';
    }

    // Opportunistically refresh status once when tab is opened.
    const statusEl = document.getElementById('aether-rag-sources-status');
    if (statusEl && !statusEl.dataset.loadedOnce) {
      statusEl.dataset.loadedOnce = 'true';
      this.refreshStatus().catch((error) => {
        this._log.warn('[LocalSourcesBinder] Sources status initial load failed:', error);
      });
    }
  }

  // =========================================================================
  // Refresh / Build
  // =========================================================================

  async refreshStatus() {
    if (!this._endpoint || typeof this._endpoint.getSources !== 'function') {
      LocalSourcesBinder._setText('aether-rag-sources-status', 'Endpoint missing getSources() implementation');
      return;
    }
    const data = await this._endpoint.getSources();
    const indexes = Array.isArray(data?.indexes) ? data.indexes : [];
    const lines = [
      `enabled: ${Boolean(data?.enabled)}`,
      `index_root_dir: ${data?.index_root_dir || ''}`,
      `registered_source_indexes: ${indexes.map((x) => x.index_name).filter(Boolean).join(', ') || '(none)'}`
    ];
    LocalSourcesBinder._setText('aether-rag-sources-status', lines.join('\n'));
  }

  async savePartial(localSources) {
    await this._endpoint.setSettings({
      integrations: {
        local_sources: localSources
      }
    });
  }

  // =========================================================================
  // Static utilities
  // =========================================================================

  static _sanitize(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return String(value);
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  static _setText(elementId, text) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = text ? String(text) : '';
  }
}

module.exports = LocalSourcesBinder;
