/**
 * @.architecture
 * Incoming: Main window menu action --- {user intent to search knowledge base}
 * Processing: fetch indexes, render search-engine UI, execute multi-index search, open documents --- {4 jobs: JOB_FETCH_INDEXES, JOB_RENDER_UI, JOB_SEARCH, JOB_OPEN_DOCUMENT}
 * Outgoing: Backend API /v1/index/list, /v1/search/indexes --- {index metadata, search results}
 *
 * Google-like search engine interface for all local AetherRag vector indexes.
 * Two-state layout: hero (idle) → results (after search).
 * Expandable source filter, advanced search options, clickable results with document opening.
 */
'use strict';

const Toast = require('../../../shared/components/Toast');
const BaseModal = require('../../../shared/modals/BaseModal');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const IndexBrowserUtils = require('./internal/IndexBrowserUtils');

const SearchService = require('./internal/services/SearchService');
const IndexingService = require('./internal/services/IndexingService');

const SearchBarComponent = require('./internal/components/SearchBarComponent');
const SidebarComponent = require('./internal/components/SidebarComponent');
const ResultsComponent = require('./internal/components/ResultsComponent');
const StudyNotesComponent = require('./internal/components/StudyNotesComponent');

// Type-to-icon mapping for result cards
const TYPE_ICONS = {
  pdf: 'fas fa-file-pdf',
  doc: 'fas fa-file-word',
  docx: 'fas fa-file-word',
  txt: 'fas fa-file-alt',
  md: 'fas fa-file-alt',
  csv: 'fas fa-file-csv',
  xls: 'fas fa-file-excel',
  xlsx: 'fas fa-file-excel',
  ppt: 'fas fa-file-powerpoint',
  pptx: 'fas fa-file-powerpoint',
  json: 'fas fa-file-code',
  xml: 'fas fa-file-code',
  html: 'fas fa-file-code',
  py: 'fas fa-file-code',
  js: 'fas fa-file-code',
  ts: 'fas fa-file-code',
  jpg: 'fas fa-file-image',
  jpeg: 'fas fa-file-image',
  png: 'fas fa-file-image',
  gif: 'fas fa-file-image',
};

const INDEX_TYPE_ICONS = {
  file_location: 'fas fa-folder-open',
  agent_output: 'fas fa-robot',
  source: 'fas fa-database',
};

const RESULTS_PER_PAGE = 20;
const SEARCH_HISTORY_KEY = 'aether-search-history';
const SEARCH_HISTORY_MAX = 10;

const { freeze } = Object;

// ---------------------------------------------------------------------------
// UI TEXT — All user-facing strings, centralized for clean modification.
// ---------------------------------------------------------------------------
const UI_TEXT = freeze({
  HERO: freeze({
    title: 'Search Your Knowledge',
    subtitleEmpty: 'Your personal search engine. Add files and folders to get started.',
    subtitlePopulated: (total) =>
      `${total} source${total !== 1 ? 's' : ''} available for search.`,
    addSource: 'Add Source',
    selectFiles: 'Select Files',
    selectFilesHint: 'PDF, DOCX, TXT, ZIP &amp; more',
    selectFolder: 'Select Folder',
    selectFolderHint: 'Index an entire directory',
  }),
  SEARCH: freeze({
    placeholder: 'Search your documents...',
    button: 'Search',
    buttonActive: 'Searching...',
    loading: (count) => `Searching ${count} source${count !== 1 ? 's' : ''}...`,
    cancel: 'Cancel',
  }),
  FILTERS: freeze({
    sourcesAll: (total) => `All Sources (${total})`,
    sourcesPartial: (selected, total) => `Sources (${selected} of ${total})`,
    advanced: 'Advanced',
    settings: 'Sources & Settings',
  }),
  SOURCES: freeze({
    toggleSelectAll: 'Select All',
    toggleDeselectAll: 'Clear Selection',
    addSource: 'Add Source',
    emptyHint: 'No knowledge sources indexed. Add files or folders to start searching.',
    chunkIndexing: 'indexing...',
    emptyChunk: 'empty',
  }),
  ADVANCED: freeze({
    topK: 'Max results',
    minScore: 'Minimum relevance',
  }),
  GROUPS: freeze({
    agent_output: 'Assistant History',
    file_location: 'Your Documents',
    source: 'Knowledge Base',
    system: 'System',
    other: 'Other',
  }),
  MODES: freeze({
    labels: freeze({
      hybrid: 'Hybrid',
      semantic: 'Smart Search',
      bm25: 'Keyword Search',
    }),
  }),
  RESULTS: freeze({
    stats: (count, duration, idxCount) => ({
      count: `${count} result${count !== 1 ? 's' : ''}`,
      duration,
      indexes: `${idxCount} source${idxCount !== 1 ? 's' : ''} searched`,
    }),
    noResultsTitle: 'No results found',
    loadMore: (nextBatch) => `Show ${nextBatch} more result${nextBatch !== 1 ? 's' : ''}`,
    loadMoreCount: (showing, total) => `(${showing} of ${total})`,
  }),
  SOURCE_MANAGER: freeze({
    addTitle: 'Add New Source',
    configTitle: 'Configure Source',
    sourceName: 'Source Name',
    sourceNamePlaceholder: 'My Documents',
    searchMode: 'Search Mode',
    indexButton: 'Index Source',
    supported: 'Supports PDF, DOCX, TXT, Markdown, CSV, JSON, ZIP archives, and more.',
    modeCards: freeze({
      combined: freeze({ label: 'Hybrid', desc: 'Smart Search + Keywords', badge: 'Recommended' }),
      semantic: freeze({ label: 'Smart Search', desc: 'Understands meaning' }),
      bm25: freeze({ label: 'Keyword Search', desc: 'Exact matching' }),
    }),
  }),
  HISTORY: freeze({
    label: 'Recent',
    clear: 'Clear',
  }),
});

const UI_CONFIG = freeze({
  AUTO_SEARCH_DEBOUNCE_MS: 400,
  AUTO_SEARCH_MIN_CHARS: 2,
  SCORE_THRESHOLDS: freeze({ HIGH: 0.85, MID: 0.6 }),
});

class IndexBrowserModal extends BaseModal {
  constructor(options = {}) {
    super({
      title: 'Search',
      id: options.id || 'index-browser-modal',
      size: options.size || 'xl',
      heightPreset: options.heightPreset || 'default',
      showFooter: false,
      container: options.container || null,
    });

    const aether = getAether();
    this.endpoint = options.endpoint || null;
    this.logger = aether?.logger || console;

    // Services
    this.searchService = new SearchService({
      endpoint: this.endpoint,
      logger: this.logger,
      settings: null // Will be updated on load
    });
    
    this.indexingService = new IndexingService({
      endpoint: this.endpoint,
      logger: this.logger
    });

    // Components (instantiated in _renderContent)
    this.components = [];

    // Local orchestrator state (not owned by domain services)
    this.sourcesExpanded = false;
    this.expandedResults = new Set();
    this._visibleCount = RESULTS_PER_PAGE;
    this.previewResult = null;
    this._deleteConfirm = null;
    this._expandedSourceInfo = null;
    this._listeners = [];

    // Bind event handlers
    this._handleSearchChange = this._handleSearchChange.bind(this);
    this._handleIndexingChange = this._handleIndexingChange.bind(this);
    this._handleJobUpdate = this._handleJobUpdate.bind(this);
    this._handleNotification = this._handleNotification.bind(this);

    this.searchService.addEventListener('change', this._handleSearchChange);
    this.searchService.addEventListener('notification', this._handleNotification);
    this.indexingService.addEventListener('change', this._handleIndexingChange);
    this.indexingService.addEventListener('job_update', this._handleJobUpdate);
    this.indexingService.addEventListener('notification', this._handleNotification);
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------

  _trackListener(element, event, handler, options) {
    if (!element || !event || !handler) return;
    element.addEventListener(event, handler, options);
    if (!this._listeners) this._listeners = [];
    this._listeners.push({ element, event, handler, options });
  }

  _clearListeners() {
    if (this._listeners) {
      this._listeners.forEach(({ element, event, handler, options }) => {
        element?.removeEventListener(event, handler, options);
      });
      this._listeners = [];
    }
  }

  _trackHeroListener(element, event, handler, options) {
    if (!element || !event || !handler) return;
    element.addEventListener(event, handler, options);
    if (!this._heroListeners) this._heroListeners = [];
    this._heroListeners.push({ element, event, handler, options });
  }

  _clearHeroListeners() {
    if (this._heroListeners) {
      this._heroListeners.forEach(({ element, event, handler, options }) => {
        element?.removeEventListener(event, handler, options);
      });
      this._heroListeners = [];
    }
  }

  async show(targetIndexName = null) {
    try {
      if (this.isOpen) {
        this.bringToFront();
        if (targetIndexName) {
          this._preselectSource(targetIndexName);
        }
        return;
      }
      if (!this.endpoint) {
        throw new Error('Endpoint not available');
      }
      this._pendingSourceSelection = targetIndexName;
      await this.open();
    } catch (error) {
      this.logger.error('Failed to open search modal:', error);
      Toast.error('Failed to open search. Please try again.');
    }
  }

  // ---------------------------------------------------------------------------
  // INITIALIZATION & RENDER
  // ---------------------------------------------------------------------------

  async _renderContent() {
    this._clearListeners();
    this._clearHeroListeners();
    this.bodyEl.innerHTML = this._buildSkeleton();

    try {
      // 1. Fetch data
      const [settings] = await Promise.all([
        this._fetchSettings(),
        this.indexingService.fetchIndexes()
      ]);

      if (settings) {
        this.searchService.setSettings(settings);
      }

      // 2. Restore selections
      const savedSelection = this._loadSelectedSources();
      if (savedSelection && savedSelection.size > 0) {
        for (const name of savedSelection) {
          if (this.indexingService.indexMap.has(name)) {
            this.indexingService.selectedSources.add(name);
          }
        }
      }

      if (this.indexingService.selectedSources.size === 0) {
        this.indexingService.indexes.forEach((idx) => {
          if (idx.is_searchable !== false) {
            this.indexingService.selectedSources.add(idx.index_name || idx.name || idx.id);
          }
        });
      }

      if (this._pendingSourceSelection) {
        this._preselectSource(this._pendingSourceSelection);
        this._pendingSourceSelection = null;
      }

      // 3. Build Shell
      const state = this.searchService.hasSearched ? 'results' : 'idle';
      const sidebarOpenClass = this.sourcesExpanded ? 'is-sidebar-open' : '';
      
      // Remove default modal body padding/scrolling so our layout can fill it
      this.bodyEl.style.padding = '0';
      this.bodyEl.style.overflow = 'hidden';
      this.bodyEl.style.display = 'flex';
      this.bodyEl.style.flexDirection = 'column';

      this.bodyEl.innerHTML = `
        <div class="se ${sidebarOpenClass}" data-state="${state}">
          <div class="se-main-area">
            <div id="se-hero-container"></div>
            <div id="se-searchbar-container"></div>
            <div id="se-results-container" style="display: flex; flex: 1; min-height: 0; flex-direction: column;"></div>
          </div>
          <div id="se-sidebar-container"></div>
          <div id="se-study-notes-container"></div>
          <!-- Toggle button for notes -->
          <button class="se-action-btn se-study-notes-toggle" id="study-notes-toggle-btn" type="button" title="Study Notes" style="position: absolute; bottom: 20px; right: 20px; z-index: 9998; border-radius: 50%; width: 48px; height: 48px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); background: var(--button-bg, #292929); color: var(--button-fg, #fff); border: 1px solid var(--border-color, #444); display: flex; align-items: center; justify-content: center; font-size: 1.2rem; cursor: pointer;">
            <i class="fas fa-sticky-note"></i>
          </button>
        </div>`;

      const mainArea = this.bodyEl.querySelector('.se-main-area');
      mainArea.querySelector('#se-hero-container').innerHTML = this._buildHero();

      // 4. Initialize Components
      this.components.forEach(c => c.dispose());
      
      this.searchBarComponent = new SearchBarComponent(
        mainArea.querySelector('#se-searchbar-container'),
        this,
        UI_TEXT,
        UI_CONFIG
      );
      
      this.resultsComponent = new ResultsComponent(
        mainArea.querySelector('#se-results-container'),
        this,
        UI_TEXT,
        UI_CONFIG,
        RESULTS_PER_PAGE
      );
      
      this.sidebarComponent = new SidebarComponent(
        this.bodyEl.querySelector('#se-sidebar-container'),
        this,
        UI_TEXT,
        INDEX_TYPE_ICONS
      );

      this.studyNotesComponent = new StudyNotesComponent(
        this.bodyEl.querySelector('#se-study-notes-container'),
        this
      );

      this.components = [this.searchBarComponent, this.resultsComponent, this.sidebarComponent, this.studyNotesComponent];

      // Attach listener for notes toggle
      const notesToggleBtn = this.bodyEl.querySelector('#study-notes-toggle-btn');
      if (notesToggleBtn) {
        this._trackListener(notesToggleBtn, 'click', () => {
          if (this.studyNotesComponent) this.studyNotesComponent.toggle();
        });
      }

      // Attach global listeners for hero
      this._attachHeroListeners();

      // 5. Detect in-progress jobs
      this.indexingService.detectInProgressJobs();
    } catch (error) {
      this.logger.error('Failed to load search data:', error);
      
      // Ensure body has proper flex display even on error
      this.bodyEl.style.padding = '0';
      this.bodyEl.style.overflow = 'hidden';
      this.bodyEl.style.display = 'flex';
      this.bodyEl.style.flexDirection = 'column';
      
      this.bodyEl.innerHTML = `
        <div class="se-error">
          <div class="se-error-icon"><i class="fas fa-exclamation-triangle"></i></div>
          <div class="se-error-title">Failed to Load</div>
          <div class="se-error-text">Backend may be unavailable. Please try again later.</div>
        </div>`;
    }
  }

  // ---------------------------------------------------------------------------
  // ORCHESTRATOR EVENT HANDLERS
  // ---------------------------------------------------------------------------

  _handleSearchChange() {
    if (!this.isOpen || !this.bodyEl) return;
    
    const se = this.bodyEl.querySelector('.se');
    if (se) {
      se.dataset.state = this.searchService.hasSearched ? 'results' : 'idle';
    }

    // When returning to idle, update hero recent searches
    if (!this.searchService.hasSearched) {
      const heroContainer = this.bodyEl.querySelector('#se-hero-container');
      if (heroContainer) {
        heroContainer.innerHTML = this._buildHero();
        this._attachHeroListeners();
      }
    }

    this.searchBarComponent?.update();
    this.resultsComponent?.update();
    
    // Save history if searching finished and we have a valid query
    if (this.searchService.hasSearched && !this.searchService.isSearching && this.searchService.searchQuery) {
      this._saveHistory(this.searchService.searchQuery);
    }
  }

  _handleIndexingChange(e) {
    if (!this.isOpen || !this.bodyEl) return;
    this._saveSelectedSources();

    // Enforce search mode compatibility when sources change
    const availModes = this._getAvailableSearchModes();
    if (availModes.size > 0 && !availModes.has(this.searchService.searchMode)) {
      const fallbackMode = availModes.has('hybrid') ? 'hybrid'
        : availModes.has('semantic') ? 'semantic'
        : [...availModes][0];
      // Note: setSearchMode fires a 'change' event on searchService,
      // which will trigger _handleSearchChange and update other components.
      this.searchService.setSearchMode(fallbackMode);
    }

    if (!e?.detail?.skipSidebarRender) {
      this.sidebarComponent?.update();
    }
    
    // Update hero if in idle state
    if (!this.searchService.hasSearched) {
      const heroContainer = this.bodyEl.querySelector('#se-hero-container');
      if (heroContainer) {
        heroContainer.innerHTML = this._buildHero();
        this._attachHeroListeners();
      }
    }
  }

  _handleJobUpdate(e) {
    if (!this.isOpen || !this.bodyEl) return;
    const { indexName } = e.detail;
    this.sidebarComponent?.updateIndexingBar(indexName);
  }

  _handleNotification(e) {
    const { type, message } = e.detail;
    if (Toast[type]) {
      Toast[type](message);
    }
  }

  async executeSearch(explicitQuery = null) {
    // Reset view state for new search
    this._visibleCount = RESULTS_PER_PAGE;
    this.expandedResults.clear();
    this.previewResult = null;
    
    const query = explicitQuery || this.searchService.searchQuery;
    const trimmedQuery = (query || '').trim();
    if (!trimmedQuery) {
      Toast.info('Please enter a search query.');
      return; // Prevent empty searches from transitioning state
    }

    const availModes = this._getAvailableSearchModes();
    
    // Explicitly transition to results state BEFORE search if valid
    const se = this.bodyEl.querySelector('.se');
    if (se) {
      se.dataset.state = 'results';
    }

    await this.searchService.executeSearch(explicitQuery, this.indexingService.selectedSources, availModes);
  }

  toggleSidebar(expanded) {
    this.sourcesExpanded = expanded;
    const se = this.bodyEl.querySelector('.se');
    if (se) {
      if (expanded) {
        se.classList.add('is-sidebar-open');
      } else {
        se.classList.remove('is-sidebar-open');
      }
    }
    this.sidebarComponent?.update();
  }

  _toggleResultExpansion(resultId) {
    if (this.expandedResults.has(resultId)) {
      this.expandedResults.delete(resultId);
    } else {
      this.expandedResults.add(resultId);
    }
    
    // Direct DOM mutation for expansion is safe and fast
    const card = this.bodyEl.querySelector(`[data-result-id="${resultId}"]`);
    if (card) {
      const snippet = card.querySelector('.se-result-snippet');
      const btn = card.querySelector('.se-action-expand');
      if (snippet) {
        snippet.classList.toggle('is-expanded', this.expandedResults.has(resultId));
      }
      if (btn) {
        const isExp = this.expandedResults.has(resultId);
        btn.innerHTML = `<i class="fas fa-${isExp ? 'compress-alt' : 'expand-alt'}"></i><span>${isExp ? 'Less' : 'More'}</span>`;
        btn.title = isExp ? 'Collapse' : 'Show more';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HERO RENDERING (Left over from renderers, minimal state)
  // ---------------------------------------------------------------------------

  _buildSkeleton() {
    return `
      <div class="se-skeleton">
        <div class="se-skeleton-bar"></div>
        <div class="se-skeleton-chips">
          <div class="skeleton-line skeleton-line--md"></div>
          <div class="skeleton-line skeleton-line--lg"></div>
          <div class="skeleton-line skeleton-line--md"></div>
        </div>
      </div>`;
  }

  _buildHero() {
    const activeJobs = [...this.indexingService.indexingJobs.values()].filter(
      (job) => job.state !== 'completed' && job.state !== 'failed'
    ).length;
    const total = this.indexingService.indexes.length + activeJobs;

    const subtitle = total === 0
      ? UI_TEXT.HERO.subtitleEmpty
      : UI_TEXT.HERO.subtitlePopulated(total);

    let heroActions = '';
    if (this.indexingService.sourceManagerState === 'idle') {
      if (total === 0) {
        heroActions = `
            <div class="se-hero-quickstart">
              <button class="se-hero-action" id="hero-pick-files" type="button">
                <i class="fas fa-file-alt"></i>
                <span class="se-hero-action-label">${UI_TEXT.HERO.selectFiles}</span>
                <span class="se-hero-action-hint">${UI_TEXT.HERO.selectFilesHint}</span>
              </button>
              <button class="se-hero-action" id="hero-pick-folder" type="button">
                <i class="fas fa-folder-open"></i>
                <span class="se-hero-action-label">${UI_TEXT.HERO.selectFolder}</span>
                <span class="se-hero-action-hint">${UI_TEXT.HERO.selectFolderHint}</span>
              </button>
            </div>`;
      } else {
        heroActions = `
            <button class="se-add-source-btn" id="hero-add-source" type="button">
              <i class="fas fa-plus-circle"></i>
              <span>${UI_TEXT.HERO.addSource}</span>
            </button>`;
      }
    }

    return `
        <div class="se-hero">
          <div class="se-hero-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </div>
          <h2 class="se-hero-title">${UI_TEXT.HERO.title}</h2>
          <p class="se-hero-subtitle">${subtitle}</p>
          ${heroActions}
          ${this._buildRecentSearches()}
        </div>`;
  }

  _buildRecentSearches() {
    const history = this._loadHistory();
    if (!history.length) return '';
    return `
        <div class="se-history">
          <div class="se-history-header">
            <span class="se-history-label">${UI_TEXT.HISTORY.label}</span>
            <button class="se-history-clear" id="hero-history-clear" type="button">${UI_TEXT.HISTORY.clear}</button>
          </div>
          <div class="se-history-chips">
            ${history.map((q) => `
              <button class="se-history-chip" data-query="${IndexBrowserUtils.escapeAttr(q)}" type="button">
                <i class="fas fa-history"></i>
                <span>${IndexBrowserUtils.escapeHtml(q)}</span>
              </button>
            `).join('')}
          </div>
        </div>`;
  }

  _attachHeroListeners() {
    this._clearHeroListeners();
    const container = this.bodyEl.querySelector('#se-hero-container');
    if (!container) return;

    const addSource = container.querySelector('#hero-add-source');
    if (addSource) {
      this._trackHeroListener(addSource, 'click', () => {
        this.indexingService.sourceManagerState = 'selecting';
        if (!this.sourcesExpanded) this.toggleSidebar(true);
        this.indexingService.dispatchEvent(new CustomEvent('change'));
      });
    }

    const pickFiles = container.querySelector('#hero-pick-files');
    if (pickFiles) {
      this._trackHeroListener(pickFiles, 'click', () => this.indexingService.handleAddFiles());
    }

    const pickFolder = container.querySelector('#hero-pick-folder');
    if (pickFolder) {
      this._trackHeroListener(pickFolder, 'click', () => this.indexingService.handleAddFolder());
    }

    const chips = container.querySelectorAll('.se-history-chip');
    chips.forEach(chip => {
      this._trackHeroListener(chip, 'click', () => {
        const query = chip.dataset.query;
        if (query) {
          this.executeSearch(query);
        }
      });
    });

    const clearBtn = container.querySelector('#hero-history-clear');
    if (clearBtn) {
      this._trackHeroListener(clearBtn, 'click', () => {
        try {
          localStorage.removeItem(SEARCH_HISTORY_KEY);
        } catch (_) {}
        
        container.innerHTML = this._buildHero();
        this._attachHeroListeners();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // DATA FETCHING & LOCAL STORAGE
  // ---------------------------------------------------------------------------

  async _fetchSettings() {
    try {
      return await this.endpoint.getSettings();
    } catch (error) {
      this.logger.warn('Failed to load settings for search defaults:', error);
      return null;
    }
  }

  _preselectSource(name) {
    const found = this.indexingService.indexes.find(
      (idx) => (idx.index_name || idx.name || idx.id) === name
    );
    if (found) {
      this.indexingService.selectedSources.clear();
      this.indexingService.selectedSources.add(name);
      this.toggleSidebar(true);
      this.indexingService.dispatchEvent(new CustomEvent('change'));
      this.logger.info(`[Search] Pre-selected source: ${name}`);
    }
  }

  _loadHistory() {
    try {
      const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((q) => typeof q === 'string' && q.trim())
        .slice(0, SEARCH_HISTORY_MAX);
    } catch (_) {
      return [];
    }
  }

  _saveHistory(query) {
    if (!query?.trim()) return;
    try {
      const history = this._loadHistory();
      const trimmed = query.trim();
      const updated = [trimmed, ...history.filter((q) => q !== trimmed)]
        .slice(0, SEARCH_HISTORY_MAX);
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
    } catch (_) {}
  }

  _loadSelectedSources() {
    try {
      const raw = localStorage.getItem('aether-selected-sources');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return new Set(parsed);
        }
      }
    } catch (_) {}
    return null;
  }

  _saveSelectedSources() {
    try {
      const arr = Array.from(this.indexingService.selectedSources);
      localStorage.setItem('aether-selected-sources', JSON.stringify(arr));
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // UTILITIES DELEGATION
  // ---------------------------------------------------------------------------

  _groupIndexes(indexes) {
    return IndexBrowserUtils.groupIndexes(indexes, UI_TEXT.GROUPS);
  }

  _getAvailableSearchModes() {
    return IndexBrowserUtils.getAvailableSearchModes(
      this.indexingService.selectedSources, 
      this.indexingService.indexMap, 
      this.indexingService.indexes
    );
  }

  _getResultTitle(result) {
    return IndexBrowserUtils.getResultTitle(result);
  }

  _getResultBreadcrumb(result) {
    return IndexBrowserUtils.getResultBreadcrumb(result, {
      indexMap: this.indexingService.indexMap,
      getDirectory: (filePath) => IndexBrowserUtils.getDirectory(filePath),
      truncateUrl: (url) => IndexBrowserUtils.truncateUrl(url),
      formatDate: (dateStr) => IndexBrowserUtils.formatDate(dateStr),
    });
  }

  _getResultIcon(result) {
    return IndexBrowserUtils.getResultIcon(result, TYPE_ICONS, INDEX_TYPE_ICONS);
  }

  _getOpenTarget(result) {
    return IndexBrowserUtils.getOpenTarget(result);
  }

  _highlightQuery(text, query) {
    return IndexBrowserUtils.highlightQuery(text, query, (input) => IndexBrowserUtils.escapeHtml(input));
  }

  // ---------------------------------------------------------------------------
  // DOCUMENT ACTIONS
  // ---------------------------------------------------------------------------

  async _openDocument(type, path) {
    if (!path) return;

    try {
      const aether = getAether();
      const bridge = aether?.artifacts?.openFile;

      if (!bridge) {
        this.logger.warn('File open bridge unavailable');
        Toast.error('File opening is not available on your system.');
        return;
      }

      if (type === 'file') {
        if (aether?.file?.read) {
          try {
            Toast.info('Loading file...');
            const result = await aether.file.read(path);
            
            if (result && result.success) {
              if (!this.fileViewerModal) {
                const FileViewerModal = require('../../../chat/modals/FileViewerModal');
                // The viewer modal should be attached to document.body, not the window's bodyEl
                // which might have its own lifecycle or overflow hidden.
                // We use document.getElementById('app') or body as container.
                this.fileViewerModal = new FileViewerModal({ 
                  endpoint: this.endpoint,
                  container: document.getElementById('app') || document.body 
                });
                // Mark as a child modal so it doesn't close the parent IndexBrowserModal
                this.fileViewerModal.isChildModal = true;
                
                // Override the close method to restore focus if needed or cleanly close
                const originalClose = this.fileViewerModal.close.bind(this.fileViewerModal);
                this.fileViewerModal.close = () => {
                  originalClose();
                  // Re-enable index browser interactions if needed
                };
              }
              
              const extension = result.filename.split('.').pop().toLowerCase();
              let mimeType = 'text/plain';
              if (result.isBinary) {
                if (extension === 'pdf') mimeType = 'application/pdf';
                else if (['jpg', 'jpeg'].includes(extension)) mimeType = 'image/jpeg';
                else mimeType = `image/${extension}`;
              }
              
              await this.fileViewerModal.open({
                filename: result.filename,
                content: result.content,
                metadata: { mime_type: mimeType }
              });

              // Log activity for Proactive Agent
              if (this.endpoint && typeof this.endpoint.logActivity === 'function') {
                this.endpoint.logActivity({
                  url: `file://${path}`,
                  title: result.filename,
                  text_content: ''
                }).catch(err => this.logger.warn('Failed to log open activity:', err));
              }

              return;
            } else if (result?.error && result.error.includes('File too large')) {
              Toast.info('File too large for internal viewer, opening externally...');
            } else {
              this.logger.warn('Failed to read file internally:', result?.error);
            }
          } catch (readErr) {
            this.logger.warn('Error reading file for internal viewer:', readErr);
          }
        }
        
        // Fallback
        bridge(path);
        Toast.info('Opening file externally...');
        
        // Log activity for external open
        if (this.endpoint && typeof this.endpoint.logActivity === 'function') {
          const title = path.split(/[/\\]/).pop() || 'Opened File';
          this.endpoint.logActivity({
            url: `file://${path}`,
            title: title,
            text_content: ''
          }).catch(err => this.logger.warn('Failed to log open activity:', err));
        }
      } else if (type === 'url') {
        bridge(path);
        Toast.info('Opening link...');
        
        // Log activity for URL open
        if (this.endpoint && typeof this.endpoint.logActivity === 'function') {
          this.endpoint.logActivity({
            url: path,
            title: 'Opened URL',
            text_content: ''
          }).catch(err => this.logger.warn('Failed to log open activity:', err));
        }
      } else {
        this.logger.warn('Unhandled document type:', type, path);
        Toast.error('This file type cannot be opened directly.');
      }
    } catch (error) {
      this.logger.error('Failed to open document:', error);
      Toast.error('Failed to open document.');
    }
  }

  _copyText(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          Toast.success('Copied to clipboard');
        }).catch(() => {
          this._fallbackCopy(text);
        });
      } else {
        this._fallbackCopy(text);
      }
    } catch (error) {
      this.logger.warn('Copy failed:', error);
    }
  }

  _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      Toast.success('Copied to clipboard');
    } catch (_) {
      Toast.error('Copy failed');
    } finally {
      document.body.removeChild(ta);
    }
  }

  // ---------------------------------------------------------------------------
  // LIFECYCLE
  // ---------------------------------------------------------------------------

  close() {
    if (this.searchService) {
      this.searchService.cancelSearch('Modal closed');
    }
    // Optionally reset specific state if needed, but we keep listeners active
    // so the modal can be re-used multiple times without re-initialization.
    this.previewResult = null;
    super.close();
  }

  destroy() {
    this.dispose();
    super.destroy();
  }

  dispose() {
    this._clearHeroListeners();

    if (this._listeners) {
      this._listeners.forEach(({ element, event, handler, options }) => {
        element?.removeEventListener(event, handler, options);
      });
      this._listeners = [];
    }

    if (this.searchService) {
      this.searchService.removeEventListener('change', this._handleSearchChange);
      this.searchService.removeEventListener('notification', this._handleNotification);
      this.searchService.dispose();
    }
    if (this.indexingService) {
      this.indexingService.removeEventListener('change', this._handleIndexingChange);
      this.indexingService.removeEventListener('job_update', this._handleJobUpdate);
      this.indexingService.removeEventListener('notification', this._handleNotification);
      this.indexingService.dispose();
    }
    this.components.forEach(c => c.dispose());
    
    if (this.fileViewerModal) {
      if (typeof this.fileViewerModal.destroy === 'function') {
        this.fileViewerModal.destroy();
      } else {
        this.fileViewerModal.close();
      }
      this.fileViewerModal = null;
    }
    
    this.expandedResults.clear();
    this._visibleCount = RESULTS_PER_PAGE;
    this.previewResult = null;
    this._deleteConfirm = null;
    this._expandedSourceInfo = null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = IndexBrowserModal;
}

if (typeof window !== 'undefined') {
  window.IndexBrowserModal = IndexBrowserModal;
}
