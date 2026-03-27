/**
 * @.architecture
 * Incoming: SettingsManager, Endpoint, Aether dialog --- {user interactions, API responses}
 * Processing: manage file indexing UI, handle CRUD operations, update location list --- {5 jobs: JOB_DELETE_FROM_DB, JOB_HTTP_REQUEST, JOB_RENDER_UI, JOB_SAVE_TO_DB, JOB_UPDATE_UI}
 * Outgoing: DOM updates, Backend API calls --- {HTML elements, HTTP requests}
 * 
 * @.security innerHTML audit: SAFE
 * Location paths displayed via textContent. innerHTML only for static card layouts, SVG icons,
 * toggle buttons, and empty states. Boolean conditions (enabled/disabled) not user-controlled.
 */

const ConfirmDialog = require('../../../shared/components/ConfirmDialog');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const ReindexJobController = require('./modules/ReindexJobController');
const DaemonController = require('./modules/DaemonController');
const LocationCardRenderer = require('./modules/LocationCardRenderer');

class FileIndexingManager {
  constructor(options = {}) {
    this.endpoint = options.endpoint;
    this.aether = options.aether || getAether();
    this.locations = [];
    this.isEnabled = true;
    this.refreshInterval = null;
    this.daemonStatus = null;
    this.activeReindexJobs = {}; // Track active reindex jobs by location_id
    this._autoRefreshInFlight = false;
    
    // DOM elements
    this.elements = {
      enableToggle: null,
      addButton: null,
      locationsList: null,
      daemonBanner: null
    };
    
    this.logger = this.aether?.logger || console;
    
    this._isDisposed = false;

    // Performance: Prevent duplicate initialization
    this._isInitialized = false;
    this._isInitializing = false;
    
    // Performance: Cache to prevent redundant API calls
    this._locationsCache = { data: null, timestamp: 0, ttl: 30000 }; // 30s cache
    
    // CRITICAL FIX: Track static DOM listeners from _setupEventListeners() for cleanup
    this._staticListeners = []; // Array of {element, event, handler}
    
    // Track status message timers for cleanup on destroy
    this._statusTimeoutId = null;
    
    // Module: DaemonController — owns daemon lifecycle, banner, restart
    this._daemonController = new DaemonController({
      endpoint: this.endpoint,
      getElements: () => this.elements,
      getIsEnabled: () => this.isEnabled,
      setIsEnabled: (val) => { this.isEnabled = val; },
      getDaemonStatus: () => this.daemonStatus,
      setDaemonStatus: (s) => { this.daemonStatus = s; },
      loadLocations: (forceRefresh) => this.loadLocations(forceRefresh),
      showSuccess: (msg) => this._showSuccess(msg),
      showError: (msg) => this._showError(msg),
      logger: this.logger,
    });

    // Module: ReindexJobController — owns all reindex job lifecycle
    this._reindexJobController = new ReindexJobController({
      endpoint: this.endpoint,
      getActiveReindexJobs: () => this.activeReindexJobs,
      setActiveReindexJob: (locationId, jobInfo) => { this.activeReindexJobs[locationId] = jobInfo; },
      deleteActiveReindexJob: (locationId) => { delete this.activeReindexJobs[locationId]; },
      getLocations: () => this.locations,
      loadLocations: (forceRefresh) => this.loadLocations(forceRefresh),
      showSuccess: (msg) => this._showSuccess(msg),
      showError: (msg) => this._showError(msg),
      escapeHtml: (text) => this._escapeHtml(text),
      logger: this.logger,
    });

    // Module: LocationCardRenderer — owns location card DOM lifecycle
    this._locationCardRenderer = new LocationCardRenderer({
      getLocations: () => this.locations,
      getElements: () => this.elements,
      getActiveReindexJobs: () => this.activeReindexJobs,
      showConfig: (location) => this.showConfig(location),
      triggerReindex: (id, name) => this.triggerReindex(id, name),
      toggleLocation: (id, enabled) => this.toggleLocation(id, enabled),
      deleteLocation: (id, name) => this.deleteLocation(id, name),
      renderInlineProgress: (locationId) => this._reindexJobController.renderInlineProgress(locationId),
      showReindexProgress: (name, jobId) => this._reindexJobController.showReindexProgress(name, jobId),
      escapeHtml: (text) => this._escapeHtml(text),
      formatBytes: (bytes) => this._formatBytes(bytes),
      formatStatus: (status) => this._formatStatus(status),
      logger: this.logger,
    });
  }

  /**
   * Initialize the file indexing manager
   */
  async initialize() {
    // Prevent duplicate initialization
    if (this._isInitialized) {
      // Idempotent init: callers may invoke initialize() on tab activation.
      // Do not spam warnings for expected re-entry.
      return;
    }
    
    if (this._isInitializing) {
      // Expected if tab is clicked rapidly while initial init is in-flight.
      return;
    }
    
    this._isInitializing = true;
    this.logger.info('[FileIndexingManager] Initializing');
    
    try {
      // Get DOM elements
      this.elements.enableToggle = document.getElementById('file-indexing-enabled');
      this.elements.addButton = document.getElementById('file-indexing-add-location');
      this.elements.locationsList = document.getElementById('file-indexing-locations-list');
      
      if (!this.elements.addButton || !this.elements.locationsList) {
        this.logger.error('[FileIndexingManager] Required DOM elements not found');
        return;
      }
      
      // Setup event listeners (only once)
      this._setupEventListeners();
      
    // UX FIX: Listen for global settings saved event to apply pending daemon state changes
    if (this.aether?.eventBus) {
      const cleanupSettings = this.aether.eventBus.on('SETTINGS.LLM_UPDATED', async (data) => {
        const newEnabled = data.settings?.integrations?.file_indexing?.enabled;
        if (newEnabled !== undefined && newEnabled !== this.daemonStatus?.running) {
          this.logger.info('[FileIndexingManager] Applying pending daemon state change:', newEnabled);
          this.isEnabled = newEnabled;
          await this._daemonController.updateEnabledState();
        }
      });
      this._staticListeners.push({ unsubscribe: cleanupSettings });
    }
      
      // Load initial data
      await this.loadLocations();
      
      // Check for any running jobs and resume tracking (delegated to module)
      await this._reindexJobController.resumeRunningJobs();
      
      this._isInitialized = true;
      this.logger.info('[FileIndexingManager] Initialized');
    } finally {
      this._isInitializing = false;
    }
  }

  /**
   * Setup event listeners - CRITICAL FIX: Track all listeners for cleanup
   *
   * GUARD: Only runs once. If initialize() fails partway (e.g., loadLocations
   * throws) and retries, the listeners from the first call are already
   * registered. Without this guard, every retry doubles the listener count.
   */
  _setupEventListeners() {
    if (this._staticListeners.length > 0) return; // Already registered
    
    // Enable/disable toggle
    if (this.elements.enableToggle) {
      const enableToggleHandler = (e) => {
        this.isEnabled = e.target.checked;
        // UX FIX: Do NOT call _updateEnabledState() immediately.
        // We only update the local state; the actual daemon start/stop
        // will be triggered by SettingsManager upon Save Changes.
        this.logger.info('[FileIndexingManager] Toggle changed (pending save):', this.isEnabled);
      };
      this.elements.enableToggle.addEventListener('change', enableToggleHandler);
      this._staticListeners.push({
        element: this.elements.enableToggle,
        event: 'change',
        handler: enableToggleHandler
      });
    }
    
    // Add location button
    const addButtonHandler = async () => {
      await this.addLocation();
    };
    this.elements.addButton.addEventListener('click', addButtonHandler);
    this._staticListeners.push({
      element: this.elements.addButton,
      event: 'click',
      handler: addButtonHandler
    });
    
    // Update add button state based on location limits
    this._locationCardRenderer.updateAddButtonState();
  }

  /**
   * Load all locations from backend (with caching)
   */
  async loadLocations(forceRefresh = false) {
    try {
      const now = Date.now();
      
      // PERFORMANCE: Use cache if fresh and not force refresh
      if (!forceRefresh && this._locationsCache.data && (now - this._locationsCache.timestamp) < this._locationsCache.ttl) {
        this.logger.info('[FileIndexingManager] Using cached locations');
        this.locations = this._locationsCache.data;
        this._renderLocations();
        return;
      }
      
      this.logger.info('[FileIndexingManager] Loading locations from API');
      const locations = await this.endpoint.getFileIndexingLocations();
      this.locations = Array.isArray(locations) ? locations : [];
      
      // Update cache
      this._locationsCache = {
        data: this.locations,
        timestamp: now,
        ttl: 30000
      };
      
      this._renderLocations();
      
      // Check if any location is 'running' and start/stop polling accordingly
      const hasRunningLocation = this.locations.some(loc => loc.last_scan_status === 'running');
      if (hasRunningLocation) {
        this._startAutoRefresh();
      } else {
        this._stopAutoRefresh();
      }
      
      // Load daemon status (delegated to module)
      await this._daemonController.loadDaemonStatus();
    } catch (error) {
      this.logger.error('[FileIndexingManager] Failed to load locations:', error);
      this._showError('Failed to load indexing locations');
    }
  }

  /**
   * Add a new indexing location
   */
  async addLocation() {
    try {
      // Check if both primary and secondary already exist
      const hasPrimary = this.locations.some(loc => loc.location_type === 'primary');
      const hasSecondary = this.locations.some(loc => loc.location_type === 'secondary');
      
      if (hasPrimary && hasSecondary) {
        this._showError('Maximum locations reached. You can only have one primary and one secondary location.');
        return;
      }
      
      // Use LocationSelectorModal for browsable selection
      let LocationSelectorModal = typeof window !== 'undefined' ? window.LocationSelectorModal : null;
      
      // If not available globally, try to require it
      if (!LocationSelectorModal && typeof require !== 'undefined') {
        try {
          LocationSelectorModal = require('./LocationSelectorModal');
        } catch (e) {
          this.logger.warn('[FileIndexingManager] LocationSelectorModal not found, using fallback');
        }
      }
      
      const selector = new LocationSelectorModal({
        onSelect: async (selection) => {
          const { path, type, indexMode } = selection;
          
          // Check again if this type already exists
          const typeExists = this.locations.some(loc => loc.location_type === type);
          if (typeExists) {
            this._showError(`A ${type} location already exists. Please delete it first or choose ${type === 'primary' ? 'secondary' : 'primary'}.`);
            return;
          }
          
          // Extract directory name for location name
          const dirName = path.split(/[/\\]/).filter(Boolean).pop() || 'Unnamed Location';
          
          // Create location
          const locationData = {
            location_name: dirName,
            root_path: path,
            location_type: type,
            index_mode: indexMode || 'combined',
            allowed_extensions: ['pdf', 'txt', 'md', 'docx', 'json', 'yaml', 'yml', 'csv'],
            exclude_patterns: [
              '**/.git/**',
              '**/node_modules/**',
              '**/__pycache__/**',
              '**/.venv/**',
              '**/build/**',
              '**/dist/**'
            ]
          };
          
          try {
            const created = await this.endpoint.createFileIndexingLocation(locationData);
            this.logger.info('[FileIndexingManager] Location created:', created);
            
            // Reload locations so the card appears immediately
            await this.loadLocations(true);
            
            this._showSuccess(`Location "${dirName}" added as ${type} location`);

            // Auto-trigger reindex so user doesn't have to click manually.
            // From a user's perspective, adding a folder means "index it".
            const locationId = created?.id;
            if (locationId) {
              try {
                await this.triggerReindex(locationId, dirName);
                this.logger.info('[FileIndexingManager] Auto-reindex triggered for new location:', locationId);
              } catch (reindexErr) {
                // Non-fatal: location is created, reindex can be triggered manually
                this.logger.warn('[FileIndexingManager] Auto-reindex failed (user can retry):', reindexErr);
              }
            }
          } catch (error) {
            this.logger.error('[FileIndexingManager] Failed to create location:', error);
            this._showError(this._formatLocationAddError(error));
          }
        },
        onCancel: () => {
          this.logger.info('[FileIndexingManager] Location selection canceled');
        }
      });
      
      await selector.show();
      
    } catch (error) {
      this.logger.error('[FileIndexingManager] Failed to show location selector:', error);
      // Fallback to simple directory picker
      await this._addLocationFallback();
    }
  }

  /**
   * Fallback to simple directory picker
   */
  async _addLocationFallback() {
    try {
      if (!this.aether?.dialog?.showDirectoryPicker) {
        this._showError('Directory picker not available');
        return;
      }
      
      const directory = await this.aether.dialog.showDirectoryPicker();
      if (!directory) return;
      
      const dirName = directory.split(/[/\\]/).filter(Boolean).pop() || 'Unnamed Location';
      
      const locationData = {
        location_name: dirName,
        root_path: directory,
        location_type: 'secondary',
        allowed_extensions: ['pdf', 'txt', 'md', 'docx', 'json', 'yaml', 'yml', 'csv'],
        exclude_patterns: [
          '**/.git/**',
          '**/node_modules/**',
          '**/__pycache__/**',
          '**/.venv/**',
          '**/build/**',
          '**/dist/**'
        ]
      };
      
      const created = await this.endpoint.createFileIndexingLocation(locationData);
      await this.loadLocations(true);
      this._showSuccess(`Location "${dirName}" added successfully`);

      // Auto-trigger reindex (same as primary addLocation path)
      const locationId = created?.id;
      if (locationId) {
        try {
          await this.triggerReindex(locationId, dirName);
          this.logger.info('[FileIndexingManager] Auto-reindex triggered (fallback):', locationId);
        } catch (reindexErr) {
          this.logger.warn('[FileIndexingManager] Auto-reindex failed (fallback, user can retry):', reindexErr);
        }
      }
    } catch (error) {
      this.logger.error('[FileIndexingManager] Fallback failed:', error);
      this._showError(this._formatLocationAddError(error));
    }
  }

  /**
   * Normalize location-create error into user-facing message.
   * Gives explicit setup guidance for backend storage initialization failures.
   */
  _formatLocationAddError(error) {
    const status = error?.status || error?.statusCode;
    const message = String(error?.message || '');
    const detail = (error && typeof error.body === 'object')
      ? String(error.body?.detail || '')
      : '';
    const haystack = `${message} ${detail}`.toLowerCase();

    const storageUnavailable = Boolean(
      error?.isBackendUnavailableError ||
      status === 503 ||
      haystack.includes('file indexing service not initialized') ||
      haystack.includes('database not available') ||
      haystack.includes('service not initialized') ||
      haystack.includes('backend unavailable')
    );

    if (storageUnavailable) {
      return 'Failed to add location: indexing service is not ready. Complete System Setup and try again.';
    }

    return `Failed to add location: ${message || 'Unknown error'}`;
  }

  /**
   * Delete a location
   */
  async deleteLocation(locationId, locationName) {
    try {
      const confirmed = await ConfirmDialog.confirm({
        title: 'Delete location',
        message: `Delete location "${locationName}"?\n\nThis will remove all indexed data for this location.`,
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger'
      });
      if (!confirmed) return;
      
      await this.endpoint.deleteFileIndexingLocation(locationId);
      this.logger.info('[FileIndexingManager] Location deleted:', locationId);
      
      await this.loadLocations(true);
      this._showSuccess(`Location "${locationName}" deleted`);
    } catch (error) {
      this.logger.error('[FileIndexingManager] Failed to delete location:', error);
      this._showError(`Failed to delete location: ${error.message}`);
    }
  }

  /**
   * Toggle location enabled/disabled
   */
  async toggleLocation(locationId, currentEnabled) {
    try {
      const updates = { enabled: !currentEnabled };
      await this.endpoint.updateFileIndexingLocation(locationId, updates);
      this.logger.info('[FileIndexingManager] Location toggled:', locationId);
      
      await this.loadLocations(true);
    } catch (error) {
      this.logger.error('[FileIndexingManager] Failed to toggle location:', error);
      this._showError(`Failed to update location: ${error.message}`);
    }
  }

  // ===========================================================================
  // Reindex delegates → ReindexJobController
  // ===========================================================================

  /** Trigger manual reindex for a location (delegated to ReindexJobController). */
  async triggerReindex(locationId, locationName) {
    return this._reindexJobController.triggerReindex(locationId, locationName);
  }

  /**
   * Show indexing configuration modal
   */
  async showConfig(location) {
    try {
      // Load IndexingConfigModal if not available
      let IndexingConfigModal = typeof window !== 'undefined' ? window.IndexingConfigModal : null;
      
      if (!IndexingConfigModal && typeof require !== 'undefined') {
        try {
          IndexingConfigModal = require('./IndexingConfigModal');
        } catch (e) {
          this.logger.error('[FileIndexingManager] IndexingConfigModal not found:', e);
          this._showError('Configuration modal not available');
          return;
        }
      }
      
      const modal = new IndexingConfigModal({
        location: location,
        onSave: async (config) => {
          try {
            // Update location with new config
            await this.endpoint.updateFileIndexingLocation(location.id, config);
            this.logger.info('[FileIndexingManager] Config updated:', location.id);
            
            // Trigger reindex
            this._showSuccess('Configuration saved. Starting reindex...');
            await this.triggerReindex(location.id, location.location_name);
          } catch (error) {
            this.logger.error('[FileIndexingManager] Failed to update config:', error);
            throw error;
          }
        },
        onCancel: () => {
          this.logger.info('[FileIndexingManager] Config canceled');
        }
      });
      
      await modal.show();
      
    } catch (error) {
      this.logger.error('[FileIndexingManager] Failed to show config:', error);
      this._showError(`Failed to show configuration: ${error.message}`);
    }
  }

  // ===========================================================================
  // Location card delegates → LocationCardRenderer
  // ===========================================================================

  /** Render/update location cards (delegated to LocationCardRenderer). */
  _renderLocations() {
    this._locationCardRenderer.renderLocations();
  }

  /**
   * Show success message
   */
  _showSuccess(message) {
    // Use existing settings status element if available
    const statusEl = document.getElementById('settings-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.style.color = 'var(--color-success)';
      // Clear any pending status timer before setting a new one
      if (this._statusTimeoutId) clearTimeout(this._statusTimeoutId);
      this._statusTimeoutId = setTimeout(() => {
        statusEl.textContent = '';
        this._statusTimeoutId = null;
      }, 3000);
    } else {
      this.logger.info('[FileIndexingManager] Success:', message);
    }
  }

  /**
   * Show error message
   */
  _showError(message) {
    // Use existing settings status element if available
    const statusEl = document.getElementById('settings-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.style.color = 'var(--color-error)';
      // Clear any pending status timer before setting a new one
      if (this._statusTimeoutId) clearTimeout(this._statusTimeoutId);
      this._statusTimeoutId = setTimeout(() => {
        statusEl.textContent = '';
        this._statusTimeoutId = null;
      }, 5000);
    } else {
      this.logger.error('[FileIndexingManager] Error:', message);
    }
  }

  /**
   * Format bytes to human-readable string
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Format status to human-readable string
   */
  _formatStatus(status) {
    const statusMap = {
      'pending': 'Pending',
      'running': 'Running',
      'completed': 'Completed',
      'failed': 'Failed',
      'timeout': 'Timeout'
    };
    return statusMap[status] || status;
  }

  /**
   * Escape HTML to prevent XSS
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Start auto-refresh polling
   */
  _startAutoRefresh() {
    if (this.refreshInterval) {
      return; // Already polling
    }
    
    this.logger.info('[FileIndexingManager] Starting auto-refresh (5s interval)');
    this.refreshInterval = setInterval(async () => {
      if (this._autoRefreshInFlight) {
        return;
      }
      this._autoRefreshInFlight = true;
      try {
        // Silent refresh - no loading indicators
        const locations = await this.endpoint.getFileIndexingLocations();
        this.locations = Array.isArray(locations) ? locations : [];

        // Keep _locationsCache in sync so subsequent loadLocations() calls
        // see fresh data even within the cache TTL window.
        this._locationsCache = { data: this.locations, timestamp: Date.now(), ttl: 30000 };

        this._renderLocations();
        
        // Check if we should stop polling
        const hasRunningLocation = this.locations.some(loc => loc.last_scan_status === 'running');
        if (!hasRunningLocation) {
          this._stopAutoRefresh();
        }
      } catch (error) {
        this.logger.error('[FileIndexingManager] Auto-refresh failed:', error);
      } finally {
        this._autoRefreshInFlight = false;
      }
    }, 5000); // Refresh every 5 seconds
  }

  /**
   * Stop auto-refresh polling
   */
  _stopAutoRefresh() {
    if (this.refreshInterval) {
      this.logger.info('[FileIndexingManager] Stopping auto-refresh');
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this._autoRefreshInFlight = false;
  }

  /**
   * Cleanup - MEMORY FIX: Complete disposal + stop all polling loops + remove ALL listeners
   */
  destroy() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.logger.info('[FileIndexingManager] Destroying');
    
    // 1. Dispose modules
    if (this._reindexJobController) {
      this._reindexJobController.dispose();
      this._reindexJobController = null;
    }
    if (this._daemonController) {
      this._daemonController.dispose();
      this._daemonController = null;
    }
    if (this._locationCardRenderer) {
      this._locationCardRenderer.dispose();
      this._locationCardRenderer = null;
    }
    
    // 2. Remove static DOM listeners from _setupEventListeners()
    for (const item of this._staticListeners) {
      try {
        if (item.unsubscribe) {
          item.unsubscribe();
        } else if (item.element) {
          item.element.removeEventListener(item.event, item.handler);
        }
      } catch (error) {
        this.logger.error('[FileIndexingManager] Failed to remove static listener:', error);
      }
    }
    this._staticListeners = [];

    // 3. Stop timers
    this._stopAutoRefresh();
    if (this._statusTimeoutId) {
      clearTimeout(this._statusTimeoutId);
      this._statusTimeoutId = null;
    }
    
    // 4. Clear caches
    this._locationsCache = { data: null, timestamp: 0, ttl: 30000 };
    
    // 5. Clear state
    this.locations = [];
    this.activeReindexJobs = {};
    this.elements = {
      enableToggle: null,
      addButton: null,
      locationsList: null,
      daemonBanner: null
    };
    
    // 6. Reset initialization flags to allow re-initialization
    this._isInitialized = false;
    this._isInitializing = false;
    
    this.logger.info('[FileIndexingManager] Destroyed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileIndexingManager;
}

if (typeof window !== 'undefined') {
  window.FileIndexingManager = FileIndexingManager;
}
