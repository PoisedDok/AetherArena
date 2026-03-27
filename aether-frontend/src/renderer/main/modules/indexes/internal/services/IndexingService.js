'use strict';

const { getAether } = require('../../../../../shared/bridge/AetherBridge');

class IndexingService extends EventTarget {
  constructor({ endpoint, logger }) {
    super();
    this.endpoint = endpoint;
    this.logger = logger;

    // State
    this.indexes = [];
    this.indexMap = new Map();
    this.selectedSources = new Set();
    
    // Source Manager State
    this.sourceManagerState = 'idle'; // idle | selecting | configuring | indexing
    this.selectedFiles = [];          // Array of { path, name, isDir }
    this.newSourceName = '';
    this.newSourceIndexMode = ['semantic', 'bm25'];
    this.chunkSize = 512;
    this.chunkOverlap = 50;
    this.indexingJobs = new Map();     // indexName -> { state, progress_pct, ... }
    
    // Lifecycle
    this._pollTimers = new Map();
    this._isSubmittingIndex = false;
    this._isDisposed = false;
  }

  async fetchIndexes() {
    if (this._isDisposed) return;
    
    try {
      const [indexResponse, sourcesResponse, filesResponse] = await Promise.all([
        this.endpoint.listIndexes(),
        this.endpoint.getSources ? this.endpoint.getSources() : Promise.resolve(null),
        this.endpoint.getFileIndexingLocations ? this.endpoint.getFileIndexingLocations() : Promise.resolve(null)
      ]);
      
      let allIndexes = indexResponse?.indexes || (Array.isArray(indexResponse) ? indexResponse : []);
      
      // Inject unindexed file locations
      if (Array.isArray(filesResponse)) {
        filesResponse.forEach(loc => {
          if (!allIndexes.find(idx => idx.index_name === loc.index_name)) {
            allIndexes.push({
              index_name: loc.index_name,
              index_type: 'file_location',
              display_name: loc.location_name,
              is_searchable: false,
              chunk_count: 0,
              supported_modes: [],
              _unindexed: true
            });
          }
        });
      }
      
      // Inject unindexed daemon sources
      if (sourcesResponse && sourcesResponse.sources) {
        if (sourcesResponse.sources.browser_history?.enabled) {
          if (!allIndexes.find(idx => idx.source_type === 'browser_history' || idx.source_type === 'browser' || idx.index_name === 'browser_history')) {
            allIndexes.push({
              index_name: 'browser_history',
              index_type: 'source',
              source_type: 'browser_history',
              display_name: 'Browser History',
              is_searchable: false,
              chunk_count: 0,
              supported_modes: [],
              _unindexed: true
            });
          }
        }
        if (sourcesResponse.sources.email?.enabled) {
          if (!allIndexes.find(idx => idx.source_type === 'email' || idx.index_name === 'email')) {
            allIndexes.push({
              index_name: 'email',
              index_type: 'source',
              source_type: 'email',
              display_name: 'Email Archive',
              is_searchable: false,
              chunk_count: 0,
              supported_modes: [],
              _unindexed: true
            });
          }
        }
      }
      
      // Filter out internal daemon sources (e.g. filesystem_events, query_generation_events) from the UI completely
      allIndexes = allIndexes.filter(idx => {
        if (idx.index_name === 'filesystem_events' || idx.index_name === 'query_generation_events') return false;
        if (idx.source_type === 'filesystem' || idx.source_type === 'query_gen') return false;
        return true;
      });

      this.indexes = allIndexes;
      this.rebuildIndexMap();
      this.dispatchEvent(new CustomEvent('change'));
    } catch (error) {
      this.logger.error('Failed to fetch indexes:', error);
      this.indexes = [];
      this.rebuildIndexMap();
      throw error;
    }
  }

  rebuildIndexMap() {
    this.indexMap.clear();
    this.indexes.forEach((idx) => {
      this.indexMap.set(idx.index_name || idx.name || idx.id, idx);
    });
  }

  toggleSourceSelection(name, skipRender = false) {
    if (this.selectedSources.has(name)) {
      this.selectedSources.delete(name);
    } else {
      this.selectedSources.add(name);
    }
    this.dispatchEvent(new CustomEvent('change', { detail: { skipSidebarRender: skipRender } }));
  }

  toggleAllSources() {
    const allSelected = this.selectedSources.size === this.indexes.length && this.indexes.length > 0;
    if (allSelected) {
      this.selectedSources.clear();
    } else {
      this.indexes.forEach(idx => {
        if (idx.is_searchable !== false) {
          this.selectedSources.add(idx.index_name || idx.name || idx.id);
        }
      });
    }
    this.dispatchEvent(new CustomEvent('change'));
  }

  _notify(type, message) {
    this.dispatchEvent(new CustomEvent('notification', { detail: { type, message } }));
  }

  async handleAddFiles() {
    try {
      const aether = getAether();
      const dialog = aether?.dialog || window.aether?.dialog;
      if (!dialog?.showFilePicker) {
        this._notify('error', 'File picker is not available on your system.');
        return;
      }

      const filePaths = await dialog.showFilePicker({
        multiSelections: true,
        filters: [{
          name: 'Documents',
          extensions: [
            'pdf', 'docx', 'doc', 'txt', 'md', 'csv', 'json', 'jsonl',
            'xlsx', 'xls', 'pptx', 'ppt', 'zip', 'xml', 'html', 'htm',
            'py', 'js', 'ts', 'java', 'c', 'cpp', 'go', 'rs', 'rb',
            'yaml', 'yml', 'toml', 'ini', 'cfg', 'sh', 'sql', 'log',
          ]
        }]
      });

      if (!filePaths || !Array.isArray(filePaths) || !filePaths.length) return;
      if (this._isDisposed) return;

      this.selectedFiles = filePaths.map((path) => ({
        path,
        name: path.split(/[\\/]/).pop() || path,
        isDir: false,
      }));
      this.newSourceName = '';
      this.chunkSize = 512;
      this.chunkOverlap = 50;
      this.sourceManagerState = 'configuring';
      this.dispatchEvent(new CustomEvent('change'));
    } catch (err) {
      this.logger.error('File picker failed:', err);
      this._notify('error', 'Failed to open file picker.');
    }
  }

  async handleAddFolder() {
    try {
      const aether = getAether();
      const dialog = aether?.dialog || window.aether?.dialog;
      if (!dialog?.showDirectoryPicker) {
        this._notify('error', 'Folder picker is not available on your system.');
        return;
      }

      const folderPath = await dialog.showDirectoryPicker();
      if (!folderPath || typeof folderPath !== 'string') return;
      if (this._isDisposed) return;

      this.selectedFiles = [{
        path: folderPath,
        name: folderPath.split(/[\\/]/).pop() || folderPath,
        isDir: true,
      }];
      this.newSourceName = '';
      this.chunkSize = 512;
      this.chunkOverlap = 50;
      this.sourceManagerState = 'configuring';
      this.dispatchEvent(new CustomEvent('change'));
    } catch (err) {
      this.logger.error('Folder picker failed:', err);
      this._notify('error', 'Failed to open folder picker.');
    }
  }

  deriveSourceName() {
    if (!this.selectedFiles.length) return '';
    if (this.selectedFiles.length === 1) {
      const name = this.selectedFiles[0].name;
      return name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    }
    const first = this.selectedFiles[0].path;
    const parts = first.replace(/\\/g, '/').split('/');
    if (parts.length >= 2) {
      return parts[parts.length - 2].replace(/[_-]/g, ' ');
    }
    return `${this.selectedFiles.length} files`;
  }

  async startIndexing() {
    if (this._isSubmittingIndex) return;

    const name = this.newSourceName.trim() || this.deriveSourceName();
    if (!name) {
      this._notify('error', 'Please provide a name for this source.');
      return;
    }
    if (!this.selectedFiles.length) {
      this._notify('error', 'No files selected.');
      return;
    }

    this._isSubmittingIndex = true;
    try {
      const sanitizedName = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '');
      if (!sanitizedName) {
        this._notify('error', 'Source name must contain at least one letter or number.');
        return;
      }
      const filePaths = this.selectedFiles.map((file) => file.path);

      const response = await this.endpoint.buildCustomSourceIndex({
        file_paths: filePaths,
        index_name: sanitizedName,
        display_name: name,
        index_mode: this.newSourceIndexMode,
        chunk_size: this.chunkSize,
        chunk_overlap: this.chunkOverlap,
        force_rebuild: false,
      });

      if (!response || !response.index_name) {
        throw new Error('Unexpected response from server');
      }

      if (this._isDisposed) return;

      this.indexingJobs.set(response.index_name, {
        state: response.state || 'queued',
        progress_pct: 0,
        files_total: response.files_total || this.selectedFiles.length,
        files_processed: 0,
        display_name: name,
        chunk_count: 0,
        error: null,
      });

      this.startIndexPoll(response.index_name);
      this.resetSourceManager();
      this._notify('success', `Indexing "${name}" started. You can continue searching.`);
      this.dispatchEvent(new CustomEvent('change'));
    } catch (err) {
      this.logger.error('Failed to start indexing:', err);
      const detail = err?.message || String(err);
      if (detail.includes('already exists')) {
        this._notify('error', 'A source with this name already exists. Use a different name or delete the existing one.');
      } else {
        this._notify('error', `Failed to start indexing: ${detail}`);
      }
    } finally {
      this._isSubmittingIndex = false;
    }
  }

  resetSourceManager() {
    this.sourceManagerState = 'idle';
    this.selectedFiles = [];
    this.newSourceName = '';
    this.newSourceIndexMode = ['semantic', 'bm25'];
    this._isSubmittingIndex = false;
    this.dispatchEvent(new CustomEvent('change'));
  }

  startIndexPoll(indexName) {
    let pollRequestInFlight = false;
    
    this._removePollTimer(indexName);

    const pollInterval = setInterval(async () => {
      if (this._isDisposed) {
        this._removePollTimer(indexName);
        return;
      }
      if (pollRequestInFlight) return;
      pollRequestInFlight = true;

      try {
        const status = await this.endpoint.getSourceIndexStatus(indexName);
        if (!status) return;
        if (this._isDisposed) {
          this._removePollTimer(indexName);
          return;
        }

        const currentJob = this.indexingJobs.get(indexName) || {};
        this.indexingJobs.set(indexName, {
          ...currentJob,
          state: status.state,
          progress_pct: status.progress_pct || 0,
          files_total: status.files_total || 0,
          files_processed: status.files_processed || 0,
          chunk_count: status.chunk_count || 0,
          error: status.error || null,
        });

        // Fire a specific event for progress bar updates if needed, 
        // or just the generic change event
        this.dispatchEvent(new CustomEvent('job_update', { detail: { indexName } }));

        if (status.state === 'completed') {
          this._removePollTimer(indexName);
          this._notify('success', `Source "${currentJob.display_name || indexName}" is ready to search (${status.chunk_count} sections processed).`);

          await this.fetchIndexes();
          if (this._isDisposed) {
            this.indexingJobs.delete(indexName);
            return;
          }
          this.selectedSources.add(indexName);
          this.indexingJobs.delete(indexName);
          this.dispatchEvent(new CustomEvent('change'));
        } else if (status.state === 'failed') {
          this._removePollTimer(indexName);
          const errMsg = status.error || 'Unknown error';
          this._notify('error', `Indexing failed: ${errMsg}`);
          this.dispatchEvent(new CustomEvent('change'));
        } else if (status.state === 'not_found') {
          this._removePollTimer(indexName);
          this.indexingJobs.delete(indexName);
          this.dispatchEvent(new CustomEvent('change'));
        }
      } catch (err) {
        this.logger.warn('Index status poll error:', err);
      } finally {
        pollRequestInFlight = false;
      }
    }, 2500);

    this._pollTimers.set(indexName, pollInterval);
  }

  _removePollTimer(indexName) {
    if (this._pollTimers.has(indexName)) {
      clearInterval(this._pollTimers.get(indexName));
      this._pollTimers.delete(indexName);
    }
  }

  clearPollTimers() {
    for (const timerId of this._pollTimers.values()) {
      clearInterval(timerId);
    }
    this._pollTimers.clear();
  }

  async handleDeleteSource(indexName) {
    try {
      this._removePollTimer(indexName);
      
      await this.endpoint.deleteSourceIndex(indexName);
      this.selectedSources.delete(indexName);
      this.indexingJobs.delete(indexName);
      this._notify('success', 'Source deleted.');

      await this.fetchIndexes();
      if (this._isDisposed) return;
      this.dispatchEvent(new CustomEvent('change'));
    } catch (err) {
      this.logger.error('Failed to delete source:', err);
      this._notify('error', `Failed to delete source: ${err?.message || err}`);
      this.dispatchEvent(new CustomEvent('change'));
    }
  }

  async cancelIndexing(indexName) {
    try {
      const job = this.indexingJobs.get(indexName);
      const displayName = job?.display_name || indexName;
      
      this._removePollTimer(indexName);
      
      await this.endpoint.deleteSourceIndex(indexName);
      
      this.indexingJobs.delete(indexName);
      this.dispatchEvent(new CustomEvent('change'));
      this._notify('info', `Indexing "${displayName}" cancelled.`);
    } catch (err) {
      this.logger.error('Failed to cancel indexing:', err);
      this._notify('error', `Failed to cancel indexing: ${err?.message || err}`);
    }
  }

  dismissIndexingJob(indexName) {
    this.indexingJobs.delete(indexName);
    this.dispatchEvent(new CustomEvent('change'));
  }

  async detectInProgressJobs() {
    if (this._isDisposed) return;
    
    try {
      const response = await this.endpoint.getActiveIndexingJobs();
      const jobs = Array.isArray(response) ? response : (response?.jobs || []);
      if (!Array.isArray(jobs) || jobs.length === 0) return;

      let discovered = 0;
      for (const job of jobs) {
        const name = job.index_name;
        if (!name) continue;

        if (this.indexingJobs.has(name)) continue;

        const state = job.state || 'queued';
        if (state === 'completed' || state === 'failed') continue;

        this.indexingJobs.set(name, {
          state,
          progress_pct: job.progress_pct || 0,
          files_total: job.files_total || 0,
          files_processed: job.files_processed || 0,
          display_name: job.display_name || name,
          chunk_count: job.chunk_count || 0,
          error: job.error || null,
        });

        this.startIndexPoll(name);
        discovered++;
      }

      if (discovered > 0 && !this._isDisposed) {
        this.dispatchEvent(new CustomEvent('change'));
      }
    } catch (err) {
      this.logger.warn('Failed to detect in-progress indexing jobs:', err);
    }
  }

  dispose() {
    if (this._isDisposed) return;
    
    for (const timerId of this._pollTimers.values()) {
      clearInterval(timerId);
    }
    this._pollTimers.clear();
    this.indexingJobs.clear();
    this._isDisposed = true;
  }
}

module.exports = IndexingService;
