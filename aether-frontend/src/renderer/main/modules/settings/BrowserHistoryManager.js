/**
 * @.architecture
 * Incoming: SettingsManager, Endpoint, Aether dialog --- {user interactions, API responses}
 * Processing: manage browser history indexing UI, discover profiles, track index status, handle progress --- {6 jobs: JOB_RENDER_UI, JOB_HTTP_REQUEST, JOB_UPDATE_UI, JOB_POLL_STATUS, JOB_TRACK_PROGRESS, JOB_DELETE_INDEX}
 * Outgoing: DOM updates, Backend API calls --- {HTML elements, HTTP requests}
 */

const ConfirmDialog = require('../../../shared/components/ConfirmDialog');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const ReindexJobController = require('./modules/ReindexJobController');

class BrowserHistoryManager {
  constructor(options = {}) {
    this.endpoint = options.endpoint;
    this.aether = options.aether || getAether();
    this.logger = this.aether?.logger || console;
    
    // State — default enabled since daemon on/off is managed by ProactiveDaemonManager,
    // not by BrowserHistoryManager. The old enable toggle was in the deleted Manual Ingestion card.
    this.isEnabled = true;
    this.selectedBrowser = 'edge';
    this.selectedProfile = null; // {profile_name, profile_path, estimated_entries}
    this.availableProfiles = [];
    this.indexStatus = null; // {semantic: {exists, chunk_count}, bm25: {exists, chunk_count}}
    this.activeIndexJob = null; // {jobId, browser, profile, startedAt}
    this.searchMode = 'hybrid'; // semantic | bm25 | hybrid
    
    // Index build selection
    this.buildSemantic = true;  // Build semantic index
    this.buildBM25 = true;      // Build BM25 index
    
    this.activeReindexJobs = {};

    // DOM elements
    this.elements = {
      enableToggle: null,
      browserSelect: null,
      profileSelect: null,
      searchModeSelect: null,
      discoverButton: null,
      buildButton: null,
      profilesList: null,
      indexStatusContainer: null,
      progressContainer: null
    };
    
    // Lifecycle management
    this._isInitialized = false;
    this._isInitializing = false;
    this._staticListeners = [];
    this._dynamicListeners = []; // Listeners from re-renders (_renderProfilesList, _renderIndexStatus)
    
    // Performance: Caching
    this._profilesCache = { data: null, timestamp: 0, ttl: 60000 }; // 1 min
    this._indexStatusCache = { data: null, timestamp: 0, ttl: 10000 }; // 10s

    this._reindexJobController = new ReindexJobController({
      endpoint: this.endpoint,
      getActiveReindexJobs: () => this.activeReindexJobs,
      setActiveReindexJob: (id, info) => { this.activeReindexJobs[id] = info; },
      deleteActiveReindexJob: (id) => { delete this.activeReindexJobs[id]; },
      getLocations: () => [{ id: 'browser', location_name: 'Browser History' }],
      loadLocations: () => this._loadIndexStatus(),
      showSuccess: (msg) => this._showSuccess(msg),
      showError: (msg) => this._showError(msg),
      escapeHtml: (text) => this._escapeHtml(text),
      logger: this.logger
    });
  }

  /**
   * Track a static event listener for cleanup (survives re-renders)
   */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._staticListeners.push({ element, event, handler, options });
  }

  /**
   * Remove all dynamic listeners (from re-renders) before attaching new ones.
   * Prevents listener accumulation across _renderProfilesList / _renderIndexStatus calls.
   */
  _clearDynamicListeners() {
    for (const { element, event, handler } of this._dynamicListeners) {
      try {
        if (element) element.removeEventListener(event, handler);
      } catch (_) { /* element may already be removed from DOM */ }
    }
    this._dynamicListeners = [];
  }

  /**
   * Track a dynamic listener created during a re-render cycle.
   */
  _trackDynamicListener(element, event, handler) {
    if (!element) return;
    element.addEventListener(event, handler);
    this._dynamicListeners.push({ element, event, handler });
  }

  /**
   * Initialize the browser history manager
   */
  async initialize() {
    if (this._isInitialized) {
      return;
    }
    
    if (this._isInitializing) {
      return;
    }
    
    this._isInitializing = true;
    this.logger.info('[BrowserHistoryManager] Initializing');
    
    try {
      // Get DOM elements (enableToggle removed — Manual Ingestion card deleted,
      // daemon on/off managed by ProactiveDaemonManager toggle)
      this.elements.browserSelect = document.getElementById('aether-rag-sources-browser-kind');
      this.elements.profileSelect = document.getElementById('aether-rag-sources-browser-profile');
      this.elements.searchModeSelect = document.getElementById('aether-rag-sources-browser-search-mode');
      this.elements.discoverButton = document.getElementById('aether-rag-sources-browser-discover');
      this.elements.buildButton = document.getElementById('aether-rag-sources-browser-build');
      this.elements.viewButton = document.getElementById('aether-rag-sources-browser-view');
      this.elements.profilesList = document.getElementById('aether-rag-sources-browser-profiles-list');
      this.elements.indexStatusContainer = document.getElementById('aether-rag-sources-browser-index-status');
      this.elements.progressContainer = document.getElementById('aether-rag-sources-browser-progress');
      
      // Debug: Log which elements were found
      this.logger.info('[BrowserHistoryManager] DOM elements found:', {
        browserSelect: !!this.elements.browserSelect,
        profileSelect: !!this.elements.profileSelect,
        searchModeSelect: !!this.elements.searchModeSelect,
        discoverButton: !!this.elements.discoverButton,
        buildButton: !!this.elements.buildButton,
        profilesList: !!this.elements.profilesList,
        indexStatusContainer: !!this.elements.indexStatusContainer,
        progressContainer: !!this.elements.progressContainer
      });
      
      if (!this.elements.browserSelect || !this.elements.buildButton) {
        this.logger.error('[BrowserHistoryManager] Required DOM elements not found');
        return;
      }
      
      // Setup event listeners
      this._setupEventListeners();
      
      // Load initial state
      await this._loadIndexStatus();

      // Check if a job is actively running
      const status = await this.endpoint.getSourceIndexStatus('browser_history');
      if (status && status.job_id && (status.state === 'processing' || status.state === 'queued' || status.state === 'paused')) {
        this.activeReindexJobs['browser'] = {
          jobId: status.job_id,
          locationName: 'Browser History',
          locationId: 'browser',
          startedAt: Date.now()
        };
        this.logger.info(`[BrowserHistoryManager] Resumed active job: ${status.job_id}`);
        this._reindexJobController._pollReindexProgress(status.job_id, 'Browser History', 'browser');
        this._reindexJobController._minimizeReindexModal('Browser History', status.job_id);
      }
      
      this._isInitialized = true;
      this.logger.info('[BrowserHistoryManager] Initialized successfully');
    } finally {
      this._isInitializing = false;
    }
  }

  /**
   * Setup event listeners - CRITICAL: Track all listeners for cleanup
   */
  _setupEventListeners() {
    // Enable toggle REMOVED — daemon on/off is managed by ProactiveDaemonManager toggle
    // on the main settings page. Auto-master-switch and auto-save behaviors removed.
    
    // Browser selection
    this._trackListener(this.elements.browserSelect, 'change', (e) => {
      this.selectedBrowser = e.target.value;
      // Clear profiles when browser changes
      this.availableProfiles = [];
      this.selectedProfile = null;
      this._profilesCache = { data: null, timestamp: 0, ttl: 60000 };
      this._renderProfilesList();
      this.logger.info('[BrowserHistoryManager] Browser changed:', this.selectedBrowser);
    });
    
    // Profile selection
    this._trackListener(this.elements.profileSelect, 'change', (e) => {
      const selectedIndex = parseInt(e.target.value);
      if (selectedIndex >= 0 && selectedIndex < this.availableProfiles.length) {
        this.selectedProfile = this.availableProfiles[selectedIndex];
        this.logger.info('[BrowserHistoryManager] Profile selected:', this.selectedProfile.profile_name);
      } else {
        this.selectedProfile = null;
      }
    });
    
    // Search mode selection
    this._trackListener(this.elements.searchModeSelect, 'change', (e) => {
      this.searchMode = e.target.value;
      this.logger.info('[BrowserHistoryManager] Search mode changed:', this.searchMode);
    });
    
    // Discover profiles button
    this._trackListener(this.elements.discoverButton, 'click', async () => {
      await this.discoverProfiles();
    });
    
    // Build index button
    this._trackListener(this.elements.buildButton, 'click', async () => {
      await this.buildIndex();
    });

    // View index browser button
    this._trackListener(this.elements.viewButton, 'click', () => {
      if (window.MainApp && typeof window.MainApp.openIndexBrowser === 'function') {
        window.MainApp.openIndexBrowser('browser_history');
      } else {
        // Fallback: Just trigger the toggle if openIndexBrowser isn't exposed
        const toggle = document.getElementById('index-browser-toggle');
        if (toggle) toggle.click();
      }
    });
  }

  /**
   * Update UI based on enabled state
   */
  _updateEnabledState() {
    const disabled = !this.isEnabled;
    
    if (this.elements.browserSelect) this.elements.browserSelect.disabled = disabled;
    if (this.elements.profileSelect) this.elements.profileSelect.disabled = disabled;
    if (this.elements.searchModeSelect) this.elements.searchModeSelect.disabled = disabled;
    if (this.elements.discoverButton) this.elements.discoverButton.disabled = disabled;
    if (this.elements.buildButton) this.elements.buildButton.disabled = disabled;
  }

  /**
   * Discover available browser profiles
   */
  async discoverProfiles() {
    if (!this.selectedBrowser) {
      this._showError('Please select a browser first');
      return;
    }
    
    // Check cache
    const now = Date.now();
    if (this._profilesCache.data && (now - this._profilesCache.timestamp) < this._profilesCache.ttl) {
      this.availableProfiles = this._profilesCache.data;
      this._renderProfilesList();
      return;
    }
    
    this.logger.info('[BrowserHistoryManager] Discovering profiles for:', this.selectedBrowser);
    
    try {
      // Show loading state
      if (this.elements.discoverButton) {
        this.elements.discoverButton.disabled = true;
        this.elements.discoverButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Discovering...';
      }
      
      const result = await this.endpoint.discoverBrowserProfiles({
        browser: this.selectedBrowser,
        user_data_dir: null // Let backend auto-detect
      });
      
      if (result.success && result.profiles) {
        this.availableProfiles = result.profiles;
        this._profilesCache = { data: result.profiles, timestamp: now, ttl: 60000 };
        
        // Auto-select first profile if none selected
        if (this.availableProfiles.length > 0 && !this.selectedProfile) {
          this.selectedProfile = this.availableProfiles[0];
        }
        
        this._renderProfilesList();
        this._showSuccess(`Found ${result.profiles.length} profile(s) with ${result.total_estimated_entries} total entries`);
      } else {
        this._showError('No profiles found');
      }
      
    } catch (error) {
      this.logger.error('[BrowserHistoryManager] Profile discovery failed:', error);
      this._showError(`Failed to discover profiles: ${error.message}`);
    } finally {
      // Restore button state
      if (this.elements.discoverButton) {
        this.elements.discoverButton.disabled = false;
        this.elements.discoverButton.innerHTML = '<i class="fas fa-search"></i> Discover Profiles';
      }
    }
  }

  /**
   * Render discovered profiles list
   */
  _renderProfilesList() {
    if (!this.elements.profilesList) return;
    
    if (!this.availableProfiles || this.availableProfiles.length === 0) {
      this.elements.profilesList.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-user-circle"></i>
          <p>No profiles discovered yet</p>
          <p class="empty-state-hint">Click "Discover Profiles" to scan for browser profiles</p>
        </div>
      `;
      return;
    }
    
    this.elements.profilesList.innerHTML = `
      <div class="profiles-grid">
        ${this.availableProfiles.map((profile, idx) => `
          <div class="profile-card ${this.selectedProfile?.profile_path === profile.profile_path ? 'selected' : ''}" data-profile-idx="${idx}">
            <div class="profile-header">
              <div class="profile-icon">
                <i class="fas fa-user-circle"></i>
              </div>
              <div class="profile-info">
                <div class="profile-name">${this._escapeHtml(profile.profile_name)}</div>
                <div class="profile-stats">
                  ${profile.estimated_entries.toLocaleString()} entries • ${profile.estimated_size_mb} MB
                </div>
                ${profile.last_modified ? `<div class="profile-date">Modified: ${this._formatDate(profile.last_modified)}</div>` : ''}
              </div>
            </div>
            <div class="profile-actions">
              <button class="btn-secondary profile-select-btn" data-profile-idx="${idx}">
                ${this.selectedProfile?.profile_path === profile.profile_path ? '<i class="fas fa-check"></i> Selected' : '<i class="fas fa-hand-pointer"></i> Select'}
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    
    // Attach listeners to select buttons — tracked for cleanup
    const selectButtons = this.elements.profilesList.querySelectorAll('.profile-select-btn');
    selectButtons.forEach((btn) => {
      const idx = parseInt(btn.dataset.profileIdx);
      const handler = () => {
        this.selectedProfile = this.availableProfiles[idx];
        this._renderProfilesList(); // Re-render to show selection
        this.logger.info('[BrowserHistoryManager] Profile selected:', this.selectedProfile.profile_name);
      };
      this._trackDynamicListener(btn, 'click', handler);
    });
  }

  /**
   * Build browser history index
   */
  async buildIndex() {
    this.logger.info('[BrowserHistoryManager] Build index clicked', {
      hasSelectedProfile: !!this.selectedProfile,
      selectedProfile: this.selectedProfile,
      availableProfiles: this.availableProfiles.length
    });
    
    if (!this.selectedProfile) {
      this._showError('Please discover and select a profile first');
      return;
    }
    
    // Check if at least one index type is selected
    if (!this.buildSemantic && !this.buildBM25) {
      this._showError('Please select at least one index type to build (click on a card to select)');
      return;
    }
    
    // Build confirmation message based on selected types
    let indexTypes = [];
    if (this.buildSemantic) indexTypes.push('Smart Search');
    if (this.buildBM25) indexTypes.push('Keyword Search');
    const indexTypesStr = indexTypes.join(' + ');
    
    this.logger.info('[BrowserHistoryManager] Showing confirmation dialog');
    const confirmed = await ConfirmDialog.confirm({
      title: 'Build Browser History Index',
      message: `Index ${this.selectedProfile.estimated_entries.toLocaleString()} entries from ${this.selectedProfile.profile_name}?\n\nBuilding: ${indexTypesStr}`,
      confirmText: 'Build Index',
      cancelText: 'Cancel',
      variant: 'default'
    });
    
    if (!confirmed) {
      this.logger.info('[BrowserHistoryManager] User cancelled build');
      return;
    }
    
    this.logger.info('[BrowserHistoryManager] User confirmed, starting build');
    
    this.logger.info('[BrowserHistoryManager] Building index for profile:', this.selectedProfile.profile_name);
    
    // Clear any existing progress interval
    if (this._progressInterval) {
      clearInterval(this._progressInterval);
      this._progressInterval = null;
    }
    
    try {
      // Disable build button
      if (this.elements.buildButton) {
        this.elements.buildButton.disabled = true;
      }
      
      const maxItems = 5000; // Default ceiling; FUTURE_WORK: expose in Settings UI (Section 7.2)
      
      const result = await this.endpoint.buildBrowserHistorySourceIndex({
        browser: this.selectedBrowser,
        profile_path: this.selectedProfile.profile_path,
        auto_find_profiles: false, // We're specifying explicit profile
        max_items: maxItems,
        force_rebuild: true,
        build_semantic: this.buildSemantic,
        build_bm25: this.buildBM25
      });
      
      if (result && result.success && result.job_id) {
        const jobId = result.job_id;
        this.activeReindexJobs['browser'] = {
          jobId,
          locationName: 'Browser History',
          locationId: 'browser',
          startedAt: Date.now()
        };
        this._reindexJobController.showReindexProgress('Browser History', jobId);
        this._reindexJobController._pollReindexProgress(jobId, 'Browser History', 'browser');
      } else {
        this._showError('Index build failed to start: Unknown error');
        if (this.elements.buildButton) {
          this.elements.buildButton.disabled = false;
        }
      }
      
    } catch (error) {
      this.logger.error('[BrowserHistoryManager] Index build failed to start:', error);
      this._showError(`Index build failed to start: ${error.message}`);
      if (this.elements.buildButton) {
        this.elements.buildButton.disabled = false;
      }
    }
  }
  /**
   * Show success message
   */
  async _loadIndexStatus() {
    try {
      // FUTURE_WORK: Dedicated index-metadata endpoint (Section 7.2).
      // Current approach: derive status from list_indexes response.
      const sources = await this.endpoint.listSources();
      const browserIndex = sources.indexes?.find(idx => idx.source_type === 'browser_history');
      
      if (browserIndex) {
        // Check if BM25 exists alongside semantic
        const indexPath = browserIndex.index_directory;
        const indexName = browserIndex.index_name;
        
        this.indexStatus = {
          exists: true,
          index_name: indexName,
          semantic: {
            exists: true,
            chunk_count: browserIndex.chunk_count || 0,
            created_at: browserIndex.created_at || browserIndex.updated_at
          },
          bm25: {
            exists: browserIndex.metadata?.bm25_enabled || false,
            chunk_count: browserIndex.metadata?.bm25_chunk_count || browserIndex.metadata?.total_entries || 0
          }
        };
      } else {
        this.indexStatus = { exists: false };
      }
      
      this._renderIndexStatus();
      
    } catch (error) {
      this.logger.error('[BrowserHistoryManager] Failed to load index status:', error);
    }
  }

  /**
   * Render index status display (semantic + BM25) - CLICKABLE for build selection
   */
  _renderIndexStatus() {
    if (!this.elements.indexStatusContainer) return;
    
    // Clean up listeners from previous render cycle before replacing DOM
    this._clearDynamicListeners();
    
    // Always show cards for selection, even if no index exists
    const hasIndex = this.indexStatus && this.indexStatus.exists;
    const semantic = hasIndex ? this.indexStatus.semantic : { exists: false, chunk_count: 0 };
    const bm25 = hasIndex ? this.indexStatus.bm25 : { exists: false, chunk_count: 0 };
    
    this.elements.indexStatusContainer.innerHTML = `
      <div class="index-status-header">
        <h4><i class="fas fa-database"></i> Index Types to Build</h4>
        ${hasIndex ? '<span class="index-status-badge index-status-active">Index Exists</span>' : '<span class="index-status-badge index-status-pending">No Index</span>'}
      </div>
      <div class="form-help form-help--spaced">Click cards to select which indexes to build/rebuild</div>
      <div class="index-status-grid">
        <!-- Smart Search Index -->
        <div class="index-type-card index-selectable ${this.buildSemantic ? 'index-selected' : ''} ${semantic.exists ? 'index-exists' : 'index-missing'}" data-index-type="semantic">
          <div class="index-type-header">
            <i class="fas fa-brain"></i>
            <span>Smart Search Index</span>
            ${this.buildSemantic ? '<i class="fas fa-check-circle index-check-selected"></i>' : ''}
            ${semantic.exists && !this.buildSemantic ? '<i class="fas fa-check-circle index-check"></i>' : ''}
            ${!semantic.exists && !this.buildSemantic ? '<i class="fas fa-times-circle index-missing-icon"></i>' : ''}
          </div>
          <div class="index-type-stats">
            ${semantic.exists ? `
              <div class="stat-item">
                <span class="stat-label">Chunks:</span>
                <span class="stat-value">${semantic.chunk_count.toLocaleString()}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Created:</span>
                <span class="stat-value">${this._formatDate(semantic.created_at)}</span>
              </div>
            ` : '<span class="index-missing-text">Will be built</span>'}
          </div>
        </div>
        
        <!-- Keyword Index -->
        <div class="index-type-card index-selectable ${this.buildBM25 ? 'index-selected' : ''} ${bm25.exists ? 'index-exists' : 'index-missing'}" data-index-type="bm25">
          <div class="index-type-header">
            <i class="fas fa-search"></i>
            <span>Keyword Index</span>
            ${this.buildBM25 ? '<i class="fas fa-check-circle index-check-selected"></i>' : ''}
            ${bm25.exists && !this.buildBM25 ? '<i class="fas fa-check-circle index-check"></i>' : ''}
            ${!bm25.exists && !this.buildBM25 ? '<i class="fas fa-times-circle index-missing-icon"></i>' : ''}
          </div>
          <div class="index-type-stats">
            ${bm25.exists ? `
              <div class="stat-item">
                <span class="stat-label">Chunks:</span>
                <span class="stat-value">${bm25.chunk_count.toLocaleString()}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Type:</span>
                <span class="stat-value">Lucene</span>
              </div>
            ` : '<span class="index-missing-text">Will be built</span>'}
          </div>
        </div>
      </div>
      
      <!-- Search Mode Selector -->
      <div class="search-mode-selector">
        <label for="aether-rag-sources-browser-search-mode">Search Mode:</label>
        <select id="aether-rag-sources-browser-search-mode" class="form-select">
          <option value="semantic" ${this.searchMode === 'semantic' ? 'selected' : ''}>Smart Search</option>
          <option value="bm25" ${this.searchMode === 'bm25' ? 'selected' : ''} ${!bm25.exists ? 'disabled' : ''}>Keyword Match</option>
          <option value="hybrid" ${this.searchMode === 'hybrid' ? 'selected' : ''} ${!bm25.exists ? 'disabled' : ''}>Combined</option>
        </select>
        ${!bm25.exists ? '<div class="form-help">Keyword Match and Combined modes require rebuilding with Keyword Index enabled</div>' : ''}
      </div>
    `;
    
    // Re-attach search mode listener after re-render — tracked for cleanup
    const searchModeSelect = document.getElementById('aether-rag-sources-browser-search-mode');
    if (searchModeSelect) {
      this.elements.searchModeSelect = searchModeSelect;
      const handler = (e) => {
        this.searchMode = e.target.value;
        this.logger.info('[BrowserHistoryManager] Search mode changed:', this.searchMode);
      };
      this._trackDynamicListener(searchModeSelect, 'change', handler);
    }
    
    // Attach click listeners to index type cards for selection — tracked for cleanup
    const indexCards = this.elements.indexStatusContainer.querySelectorAll('.index-selectable');
    indexCards.forEach(card => {
      const indexType = card.dataset.indexType;
      const handler = () => {
        if (indexType === 'semantic') {
          this.buildSemantic = !this.buildSemantic;
        } else if (indexType === 'bm25') {
          this.buildBM25 = !this.buildBM25;
        }
        this._renderIndexStatus(); // Re-render to show selection
        this.logger.info('[BrowserHistoryManager] Index selection changed:', {
          semantic: this.buildSemantic,
          bm25: this.buildBM25
        });
      };
      this._trackDynamicListener(card, 'click', handler);
    });
  }

  /**
   * Load current index status (semantic + BM25)
   */
  _showSuccess(message) {
    this.logger.info('[BrowserHistoryManager] Success:', message);
    if (this.aether?.toast) {
      this.aether.toast.success(message);
    } else if (window.showToast) {
      window.showToast(message, 'success');
    } else {
      alert(message); // Fallback
    }
  }

  /**
   * Show error message
   */
  _showError(message) {
    this.logger.error('[BrowserHistoryManager] Error:', message);
    if (this.aether?.toast) {
      this.aether.toast.error(message);
    } else if (window.showToast) {
      window.showToast(message, 'error');
    } else {
      alert('Error: ' + message); // Fallback
    }
  }

  /**
   * Format date for display
   */
  _formatDate(isoString) {
    if (!isoString) return 'Unknown';
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    } catch {
      return isoString;
    }
  }

  /**
   * Escape HTML for safe rendering
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy() {
    this.logger.info('[BrowserHistoryManager] Destroying');
    
    if (this._reindexJobController) {
      this._reindexJobController.dispose();
      this._reindexJobController = null;
    }
    
    // Clear caches
    this._profilesCache = { data: null, timestamp: 0, ttl: 60000 };
    this._indexStatusCache = { data: null, timestamp: 0, ttl: 10000 };
    
    // Remove all dynamic listeners from re-renders
    this._clearDynamicListeners();
    
    // Remove all static listeners
    for (const listener of this._staticListeners) {
      if (listener.unsubscribe) {
        listener.unsubscribe();
      } else if (listener.element && listener.event && listener.handler) {
        listener.element.removeEventListener(listener.event, listener.handler);
      }
    }
    this._staticListeners = [];
    
    // Clear state
    this.availableProfiles = [];
    this.selectedProfile = null;
    this.indexStatus = null;
    this.activeIndexJob = null;
    
    // Reset lifecycle flags
    this._isInitialized = false;
    this._isInitializing = false;
    
    this.logger.info('[BrowserHistoryManager] Destroyed');
  }
}

module.exports = BrowserHistoryManager;
