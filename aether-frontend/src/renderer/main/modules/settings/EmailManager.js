/**
 * @.architecture
 * Incoming: SettingsManager, Endpoint, Aether dialog --- {user interactions, API responses}
 * Processing: manage email history indexing UI, track index status, handle progress --- {5 jobs: JOB_RENDER_UI, JOB_HTTP_REQUEST, JOB_UPDATE_UI, JOB_POLL_STATUS, JOB_TRACK_PROGRESS}
 * Outgoing: DOM updates, Backend API calls --- {HTML elements, HTTP requests}
 */

const { getAether } = require('../../../shared/bridge/AetherBridge');
const ConfirmDialog = require('../../../shared/components/ConfirmDialog');
const ReindexJobController = require('./modules/ReindexJobController');

class EmailManager {
  constructor(options = {}) {
    this.endpoint = options.endpoint;
    this.aether = options.aether || getAether();
    this.logger = this.aether?.logger || console;
    
    // State
    this.isEnabled = true;
    this.indexStatus = null; // {semantic: {exists, chunk_count}, bm25: {exists, chunk_count}}
    this.searchMode = 'hybrid'; // semantic | bm25 | hybrid
    
    // Index build selection
    this.buildSemantic = true;  // Build semantic index
    this.buildBM25 = true;      // Build BM25 index
    
    this.activeReindexJobs = {};

    // DOM elements
    this.elements = {
      sourcePathInput: null,
      maxItemsInput: null,
      searchModeSelect: null,
      buildButton: null,
      viewButton: null,
      indexStatusContainer: null,
      progressContainer: null
    };
    
    // Lifecycle management
    this._isInitialized = false;
    this._isInitializing = false;
    this._staticListeners = [];
    this._dynamicListeners = []; // Listeners from re-renders (_renderIndexStatus)
    
    // Performance: Caching
    this._indexStatusCache = { data: null, timestamp: 0, ttl: 10000 }; // 10s

    this._reindexJobController = new ReindexJobController({
      endpoint: this.endpoint,
      getActiveReindexJobs: () => this.activeReindexJobs,
      setActiveReindexJob: (id, info) => { this.activeReindexJobs[id] = info; },
      deleteActiveReindexJob: (id) => { delete this.activeReindexJobs[id]; },
      getLocations: () => [{ id: 'email', location_name: 'Email Archive' }],
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
   * Initialize the email manager
   */
  async initialize() {
    if (this._isInitialized) return;
    if (this._isInitializing) return;
    
    this._isInitializing = true;
    this.logger.info('[EmailManager] Initializing');
    
    try {
      this.elements.sourcePathInput = document.getElementById('aether-rag-sources-email-source-path');
      this.elements.maxItemsInput = document.getElementById('aether-rag-sources-email-max-items');
      this.elements.searchModeSelect = document.getElementById('aether-rag-sources-email-search-mode');
      this.elements.buildButton = document.getElementById('aether-rag-sources-email-build');
      this.elements.viewButton = document.getElementById('aether-rag-sources-email-view');
      this.elements.indexStatusContainer = document.getElementById('aether-rag-sources-email-index-status');
      this.elements.progressContainer = document.getElementById('aether-rag-sources-email-progress');
      
      this.logger.info('[EmailManager] DOM elements found:', {
        sourcePathInput: !!this.elements.sourcePathInput,
        maxItemsInput: !!this.elements.maxItemsInput,
        searchModeSelect: !!this.elements.searchModeSelect,
        buildButton: !!this.elements.buildButton,
        indexStatusContainer: !!this.elements.indexStatusContainer,
        progressContainer: !!this.elements.progressContainer
      });
      
      if (!this.elements.buildButton) {
        this.logger.error('[EmailManager] Required DOM elements not found');
        return;
      }
      
      // Load current settings from backend into the fields
      await this._loadInitialSettings();
      
      this._setupEventListeners();
      await this._loadIndexStatus();

      // Check if a job is actively running
      const status = await this.endpoint.getSourceIndexStatus('email');
      if (status && status.job_id && (status.state === 'processing' || status.state === 'queued' || status.state === 'paused')) {
        this.activeReindexJobs['email'] = {
          jobId: status.job_id,
          locationName: 'Email Archive',
          locationId: 'email',
          startedAt: Date.now()
        };
        this.logger.info(`[EmailManager] Resumed active job: ${status.job_id}`);
        // We do not auto-show the modal (it's disruptive on load), we just start polling.
        // It will show a minimized bar if ReindexJobController supports it or just update silently.
        this._reindexJobController._pollReindexProgress(status.job_id, 'Email Archive', 'email');
        
        // Show minimized bar to let the user know it's running in background
        this._reindexJobController._minimizeReindexModal('Email Archive', status.job_id);
      }
      
      this._isInitialized = true;
      this.logger.info('[EmailManager] Initialized successfully');
    } finally {
      this._isInitializing = false;
    }
  }

  /**
   * Setup event listeners - CRITICAL: Track all listeners for cleanup
   */
  _setupEventListeners() {
    // Search mode selection
    this._trackListener(this.elements.searchModeSelect, 'change', (e) => {
      this.searchMode = e.target.value;
      this.logger.info('[EmailManager] Search mode changed:', this.searchMode);
    });
    
    // Build index button
    this._trackListener(this.elements.buildButton, 'click', async () => {
      await this.buildIndex();
    });

    // View index browser button
    this._trackListener(this.elements.viewButton, 'click', () => {
      if (window.MainApp && typeof window.MainApp.openIndexBrowser === 'function') {
        window.MainApp.openIndexBrowser('email');
      } else {
        const toggle = document.getElementById('index-browser-toggle');
        if (toggle) toggle.click();
      }
    });
  }

  async _loadInitialSettings() {
    try {
      const data = await this.endpoint.getSources();
      const emailConfig = data?.sources?.email || {};
      if (this.elements.sourcePathInput && emailConfig.source_path) {
        this.elements.sourcePathInput.value = emailConfig.source_path;
      }
      if (this.elements.maxItemsInput && emailConfig.max_items) {
        this.elements.maxItemsInput.value = emailConfig.max_items;
      }
    } catch (err) {
      this.logger.warn('[EmailManager] Failed to load initial settings:', err);
    }
  }

  async _loadIndexStatus() {
    try {
      const sources = await this.endpoint.listSources();
      const emailIndex = sources.indexes?.find(idx => idx.source_type === 'email');
      
      if (emailIndex) {
        const indexName = emailIndex.index_name;
        
        this.indexStatus = {
          exists: true,
          index_name: indexName,
          semantic: {
            exists: true,
            chunk_count: emailIndex.chunk_count || 0,
            created_at: emailIndex.created_at || emailIndex.updated_at
          },
          bm25: {
            exists: emailIndex.metadata?.bm25_enabled || false,
            chunk_count: emailIndex.metadata?.bm25_chunk_count || emailIndex.metadata?.total_entries || 0
          }
        };
      } else {
        this.indexStatus = { exists: false };
      }
      
      this._renderIndexStatus();
      
    } catch (error) {
      this.logger.error('[EmailManager] Failed to load index status:', error);
    }
  }

  _renderIndexStatus() {
    if (!this.elements.indexStatusContainer) return;
    
    this._clearDynamicListeners();
    
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
        <label for="aether-rag-sources-email-search-mode">Search Mode:</label>
        <select id="aether-rag-sources-email-search-mode" class="form-select">
          <option value="semantic" ${this.searchMode === 'semantic' ? 'selected' : ''}>Smart Search</option>
          <option value="bm25" ${this.searchMode === 'bm25' ? 'selected' : ''} ${!bm25.exists ? 'disabled' : ''}>Keyword Match</option>
          <option value="hybrid" ${this.searchMode === 'hybrid' ? 'selected' : ''} ${!bm25.exists ? 'disabled' : ''}>Combined</option>
        </select>
        ${!bm25.exists ? '<div class="form-help">Keyword Match and Combined modes require rebuilding with Keyword Index enabled</div>' : ''}
      </div>
    `;
    
    const searchModeSelect = document.getElementById('aether-rag-sources-email-search-mode');
    if (searchModeSelect) {
      this.elements.searchModeSelect = searchModeSelect;
      const handler = (e) => {
        this.searchMode = e.target.value;
        this.logger.info('[EmailManager] Search mode changed:', this.searchMode);
      };
      this._trackDynamicListener(searchModeSelect, 'change', handler);
    }
    
    const indexCards = this.elements.indexStatusContainer.querySelectorAll('.index-selectable');
    indexCards.forEach(card => {
      const indexType = card.dataset.indexType;
      const handler = () => {
        if (indexType === 'semantic') {
          this.buildSemantic = !this.buildSemantic;
        } else if (indexType === 'bm25') {
          this.buildBM25 = !this.buildBM25;
        }
        this._renderIndexStatus();
        this.logger.info('[EmailManager] Index selection changed:', {
          semantic: this.buildSemantic,
          bm25: this.buildBM25
        });
      };
      this._trackDynamicListener(card, 'click', handler);
    });
  }

  async buildIndex() {
    this.logger.info('[EmailManager] Build index clicked');
    
    if (!this.buildSemantic && !this.buildBM25) {
      this._showError('Please select at least one index type to build (click on a card to select)');
      return;
    }
    
    let indexTypes = [];
    if (this.buildSemantic) indexTypes.push('Smart Search');
    if (this.buildBM25) indexTypes.push('Keyword Search');
    const indexTypesStr = indexTypes.join(' + ');
    
    const sourcePath = this.elements.sourcePathInput?.value?.trim() || '';
    const maxItems = parseInt(this.elements.maxItemsInput?.value || '1000', 10);
    
    const confirmed = await ConfirmDialog.confirm({
      title: 'Build Email Index',
      message: `Index up to ${maxItems} emails${sourcePath ? ' from ' + sourcePath : ''}?\n\nBuilding: ${indexTypesStr}`,
      confirmText: 'Build Index',
      cancelText: 'Cancel',
      variant: 'default'
    });
    
    if (!confirmed) return;
    
    this.logger.info('[EmailManager] User confirmed, starting build');
    
    try {
      if (this.elements.buildButton) this.elements.buildButton.disabled = true;
      
      const result = await this.endpoint.buildEmailSourceIndex({
        source_path: sourcePath,
        max_items: maxItems,
        force_rebuild: true,
        build_semantic: this.buildSemantic,
        build_bm25: this.buildBM25
      });
      
      if (result && result.success && result.job_id) {
        const jobId = result.job_id;
        this.activeReindexJobs['email'] = {
          jobId,
          locationName: 'Email Archive',
          locationId: 'email',
          startedAt: Date.now()
        };
        this._reindexJobController.showReindexProgress('Email Archive', jobId);
        this._reindexJobController._pollReindexProgress(jobId, 'Email Archive', 'email');
      } else {
        this._showError('Index build failed to start: Unknown error');
        if (this.elements.buildButton) this.elements.buildButton.disabled = false;
      }
      
    } catch (error) {
      this.logger.error('[EmailManager] Index build failed to start:', error);
      this._showError(`Index build failed to start: ${error.message}`);
      if (this.elements.buildButton) this.elements.buildButton.disabled = false;
    }
  }
  _showSuccess(message) {
    this.logger.info('[EmailManager] Success:', message);
    if (this.aether?.toast) {
      this.aether.toast.success(message);
    } else if (window.showToast) {
      window.showToast(message, 'success');
    } else {
      alert(message);
    }
  }

  _showError(message) {
    this.logger.error('[EmailManager] Error:', message);
    if (this.aether?.toast) {
      this.aether.toast.error(message);
    } else if (window.showToast) {
      window.showToast(message, 'error');
    } else {
      alert('Error: ' + message);
    }
  }

  _formatDate(isoString) {
    if (!isoString) return 'Unknown';
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    } catch {
      return isoString;
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Destroy and cleanup all resources
   */
  destroy() {
    this.logger.info('[EmailManager] Destroying');
    
    if (this._reindexJobController) {
      this._reindexJobController.dispose();
      this._reindexJobController = null;
    }
    
    this._indexStatusCache = { data: null, timestamp: 0, ttl: 10000 };
    
    this._clearDynamicListeners();
    
    for (const listener of this._staticListeners) {
      if (listener.unsubscribe) {
        listener.unsubscribe();
      } else if (listener.element && listener.event && listener.handler) {
        listener.element.removeEventListener(listener.event, listener.handler);
      }
    }
    this._staticListeners = [];
    
    this._isInitialized = false;
    this.logger.info('[EmailManager] Destroyed');
  }
}

module.exports = EmailManager;
