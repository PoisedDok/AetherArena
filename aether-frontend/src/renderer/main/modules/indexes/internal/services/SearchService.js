'use strict';

class SearchService extends EventTarget {
  constructor({ endpoint, logger, settings }) {
    super();
    this.endpoint = endpoint;
    this.logger = logger;
    
    // State
    this.searchQuery = '';
    this.searchResults = [];
    this.isSearching = false;
    this.hasSearched = false;
    this.searchDuration = 0;
    this.indexesSearched = [];
    
    this.searchMode = 'bm25';
    this.topK = settings?.agents?.context_retrieval?.default_top_k ?? 10;
    this.minScore = settings?.agents?.context_retrieval?.min_score ?? 0.0;
    
    // Lifecycle
    this._searchAbortController = null;
    this._searchSeq = 0;
    this._isDisposed = false;
  }

  setSettings(settings) {
    if (settings?.agents?.context_retrieval) {
      if (settings.agents.context_retrieval.default_top_k !== undefined) {
        this.topK = settings.agents.context_retrieval.default_top_k;
      }
      if (settings.agents.context_retrieval.min_score !== undefined) {
        this.minScore = settings.agents.context_retrieval.min_score;
      }
    }
  }

  setSearchMode(mode) {
    if (this.searchMode !== mode) {
      this.searchMode = mode;
      this.dispatchEvent(new CustomEvent('change'));
    }
  }
  
  setTopK(val) {
    if (this.topK !== val) {
      this.topK = val;
      this.dispatchEvent(new CustomEvent('change'));
    }
  }

  setMinScore(val) {
    if (this.minScore !== val) {
      this.minScore = val;
      this.dispatchEvent(new CustomEvent('change'));
    }
  }

  clearSearch(reason = 'User cancelled') {
    this.cancelSearch(reason);
    this.searchQuery = '';
    this.hasSearched = false;
    this.searchResults = [];
    this.searchDuration = 0;
    this.indexesSearched = [];
    this.dispatchEvent(new CustomEvent('change'));
  }

  _notify(type, message) {
    this.dispatchEvent(new CustomEvent('notification', { detail: { type, message } }));
  }

  async executeSearch(query, selectedSources, availableModes) {
    if (this._isDisposed) return;
    
    const trimmedQuery = (query || this.searchQuery).trim();
    if (!trimmedQuery) {
      // Don't set hasSearched = true for empty queries to avoid blank results screen
      return;
    }

    if (!selectedSources || selectedSources.size === 0) {
      this.hasSearched = true;
      this.dispatchEvent(new CustomEvent('change'));
      this._notify('error', 'Select at least one source to search.');
      return;
    }

    if (availableModes && !availableModes.has(this.searchMode)) {
      this.hasSearched = true;
      this.dispatchEvent(new CustomEvent('change'));
      this._notify('error', 'Selected sources are incompatible with the current search mode.');
      return;
    }

    this.cancelSearch();

    this.searchQuery = trimmedQuery;
    this.isSearching = true;
    this.hasSearched = true;
    this._searchSeq++;
    
    const mySeq = this._searchSeq;
    const abortController = new AbortController();
    this._searchAbortController = abortController;
    
    try {
      this.dispatchEvent(new CustomEvent('change'));

      const response = await this.endpoint.searchIndexes({
        query: trimmedQuery,
        index_names: Array.from(selectedSources),
        top_k: this.topK,
        min_score: this.minScore,
        mode: this.searchMode,
      }, {
        signal: abortController.signal,
        timeout: 30000,
        allowRetry: false
      });

      if (mySeq !== this._searchSeq || this._isDisposed) return;

      this.searchResults = (response?.results || []).filter(res => {
        // Hide internal Aether navigation/search logs from the UI
        const url = res?.metadata?.url || '';
        return !url.startsWith('aether://') && !url.includes('localhost:3000/');
      });
      this.searchDuration = response?.search_duration_ms || 0;
      this.indexesSearched = response?.indexes_searched || [];

      // Proactive pipeline log: record the search activity
      if (this.endpoint && typeof this.endpoint.logActivity === 'function') {
        this.endpoint.logActivity({
          url: `aether://search?q=${encodeURIComponent(trimmedQuery)}`,
          title: `Search: ${trimmedQuery}`,
          text_content: trimmedQuery.slice(0, 500)
        }).catch(err => {
          this.logger.warn('[SearchService] Failed to log search activity:', err);
        });
      }
    } catch (error) {
      if (mySeq !== this._searchSeq || this._isDisposed) return;

      if (abortController.signal.aborted) {
        if (abortController.signal.reason === 'User cancelled') {
          this._notify('info', 'Search cancelled.');
        }
        this.searchResults = [];
      } else if (error?.isTimeoutError === true || error?.name === 'TimeoutError') {
        this.searchResults = [];
        this.dispatchEvent(new CustomEvent('change'));
        this._notify('error', 'Search timed out. Try a shorter search or select fewer sources.');
      } else {
        this.logger.error('Search failed:', error);
        this.searchResults = [];
        // Ensure UI updates to clear searching state even on failure
        this.dispatchEvent(new CustomEvent('change'));
        this._notify('error', 'Search failed. Please try again.');
      }
    } finally {
      if (this._searchAbortController === abortController) {
        this._searchAbortController = null;
      }
      if (mySeq === this._searchSeq && !this._isDisposed) {
        this.isSearching = false;
        try {
          this.dispatchEvent(new CustomEvent('change'));
        } catch(e) {
          this.logger.error('Error dispatching change event in finally:', e);
        }
      }
    }
  }

  cancelSearch(reason = 'User cancelled') {
    if (this._searchAbortController) {
      this._searchAbortController.abort(reason);
      this._searchAbortController = null;
      this.isSearching = false;
      this.dispatchEvent(new CustomEvent('change'));
    }
  }

  dispose() {
    if (this._isDisposed) return;
    this.cancelSearch();
    this._isDisposed = true;
  }
}

module.exports = SearchService;
