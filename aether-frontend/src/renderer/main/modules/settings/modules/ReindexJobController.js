'use strict';

/**
 * @.architecture
 * Incoming: FileIndexingManager orchestrator via closures --- {method calls, job triggers}
 * Processing: manage reindex job lifecycle, poll progress, control modal/inline UI --- {4 jobs: JOB_HTTP_REQUEST, JOB_POLL_LOOP, JOB_RENDER_UI, JOB_UPDATE_UI}
 * Outgoing: Endpoint API, DOM progress elements --- {HTTP requests, HTML elements}
 */

const ConfirmDialog = require('../../../../shared/components/ConfirmDialog');

class ReindexJobController {
  /**
   * @param {Object} options
   * @param {Object} options.endpoint - API endpoint (FileIndexingApi)
   * @param {Function} options.getActiveReindexJobs - () => activeReindexJobs object
   * @param {Function} options.setActiveReindexJob - (locationId, jobInfo) => void
   * @param {Function} options.deleteActiveReindexJob - (locationId) => void
   * @param {Function} options.getLocations - () => locations array
   * @param {Function} options.loadLocations - (forceRefresh?) => Promise
   * @param {Function} options.showSuccess - (message) => void
   * @param {Function} options.showError - (message) => void
   * @param {Function} options.escapeHtml - (text) => string
   * @param {Object} options.logger
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint;
    this.getActiveReindexJobs = options.getActiveReindexJobs;
    this.setActiveReindexJob = options.setActiveReindexJob;
    this.deleteActiveReindexJob = options.deleteActiveReindexJob;
    this.getLocations = options.getLocations;
    this.loadLocations = options.loadLocations;
    this.showSuccess = options.showSuccess;
    this.showError = options.showError;
    this.escapeHtml = options.escapeHtml;
    this.logger = options.logger || console;

    this._isDisposed = false;

    // Polling loops — tracked for cleanup via destroy()
    this._activePolls = new Map(); // Map<jobId, {value: boolean}>

    // Reindex modal listeners — tracked for cleanup
    this._reindexModalListeners = [];
    this._reindexPauseHandler = null;

    // Active jobs cache — Map<locationId, {data, timestamp}>
    this._activeJobsCache = new Map();
    this._activeJobsCacheTTL = 5000; // 5s

    // BUG 3 FIX: Track dynamically-created inline progress listeners
    this._inlineProgressListeners = new Map(); // Map<locationId, Array<{element, event, handler}>>

    // Minimized bar state
    this._isMinimized = false;
    this._minimizedBarEl = null;
    this._minimizedBarListeners = [];

    // Smart estimation state — reset per job
    this._estimation = {
      startTime: null,
      lastPollTime: null,
      lastFilesScanned: 0,
      speedEMA: 0,
      speedSamples: 0,
    };

    // Last known status per location for immediate UI population
    this._lastStatus = new Map(); // Map<locationId, status>

    // App-close guard (bound once, cleaned in dispose)
    this._beforeUnloadHandler = null;
    this._hasActiveIndexing = false;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Trigger manual reindex for a location (async with polling).
   * @param {string} locationId
   * @param {string} locationName
   */
  async triggerReindex(locationId, locationName) {
    try {
      this.logger.info(`[ReindexJobController] Triggering async reindex for ${locationName}`);

      const result = await this.endpoint.triggerFileIndexingReindex(locationId);
      const jobId = result.job_id;

      this.logger.info(`[ReindexJobController] Reindex job ${jobId} created`);

      this.setActiveReindexJob(locationId, {
        jobId,
        locationName,
        locationId,
        startedAt: Date.now(),
      });

      this._showReindexProgress(locationName, jobId);
      await this._pollReindexProgress(jobId, locationName, locationId);
    } catch (error) {
      this._hideReindexProgress();
      this.logger.error('[ReindexJobController] Failed to trigger reindex:', error);
      this.showError(`Failed to start reindex: ${error.message}`);
    }
  }

  /**
   * Resume tracking any running jobs on page load.
   */
  async resumeRunningJobs() {
    try {
      const locations = this.getLocations();
      const now = Date.now();
      const jobCheckPromises = locations.map(async (location) => {
        try {
          // Check cache first
          const cached = this._activeJobsCache.get(location.id);
          if (cached && (now - cached.timestamp) < this._activeJobsCacheTTL) {
            if (cached.data) {
              this.logger.info(`[ReindexJobController] Using cached active job for ${location.location_name}`);
              const activeJobs = this.getActiveReindexJobs();
              if (!activeJobs[location.id]) {
                this.setActiveReindexJob(location.id, {
                  jobId: cached.data.job_id,
                  locationName: location.location_name,
                  locationId: location.id,
                  startedAt: Date.now(),
                });
                this._pollReindexProgress(cached.data.job_id, location.location_name, location.id);
              }
              return location.location_name;
            }
            return null;
          }

          // Use dedicated API method (no hardcoded URLs)
          const jobInfo = await this.endpoint.getActiveJobForLocation(location.id);
          if (jobInfo && jobInfo.job_id) {
            this._activeJobsCache.set(location.id, { data: jobInfo, timestamp: now });

            this.logger.info(`[ReindexJobController] Found active job for ${location.location_name} (status: ${jobInfo.status})`);

            this.setActiveReindexJob(location.id, {
              jobId: jobInfo.job_id,
              locationName: location.location_name,
              locationId: location.id,
              startedAt: Date.now(),
            });

            this._pollReindexProgress(jobInfo.job_id, location.location_name, location.id);
            return location.location_name;
          }

          this._activeJobsCache.set(location.id, { data: null, timestamp: now });
          return null;
        } catch (error) {
          const status = error?.status || error?.response?.status;
          if (status !== 404 && error?.message && !error.message.includes('404')) {
            this.logger.warn(`[ReindexJobController] Could not check job for ${location.location_name}:`, error);
          }
          this._activeJobsCache.set(location.id, { data: null, timestamp: now });
          return null;
        }
      });

      const resumed = (await Promise.all(jobCheckPromises)).filter(Boolean);
      if (resumed.length > 0) {
        this.logger.info(`[ReindexJobController] Resumed ${resumed.length} active job(s): ${resumed.join(', ')}`);
      }
    } catch (error) {
      this.logger.error('[ReindexJobController] Failed to resume running jobs:', error);
    }
  }

  /**
   * Render inline progress HTML for a location card (returns HTML string).
   * @param {string} locationId
   * @returns {string} HTML string
   */
  renderInlineProgress(locationId) {
    const activeJobs = this.getActiveReindexJobs();
    const activeJob = activeJobs[locationId];
    if (!activeJob) return '';

    const existingProgress = document.querySelector(`.inline-reindex-progress[data-location-id="${locationId}"]`);
    if (existingProgress) {
      return existingProgress.outerHTML;
    }

    return `
      <div class="inline-reindex-progress" data-location-id="${locationId}">
        <div class="inline-reindex-header">
          <div class="inline-reindex-title">
            <i class="fas fa-cog fa-spin"></i>
            <span>Reindexing in progress...</span>
          </div>
          <button class="inline-view-details-btn" data-job-id="${activeJob.jobId}" data-location-name="${this.escapeHtml(activeJob.locationName)}">
            View Details
          </button>
        </div>
        <div class="inline-progress-bar">
          <div class="inline-progress-fill" style="width: 0%"></div>
        </div>
        <div class="inline-reindex-stats">Initializing...</div>
      </div>
    `;
  }

  /**
   * Remove inline progress display for a location.
   * @param {string} locationId
   */
  removeInlineProgress(locationId) {
    // Clean tracked inline progress listeners for this location (BUG 3 FIX)
    this._cleanupInlineProgressListeners(locationId);

    const container = document.querySelector(`.inline-reindex-progress[data-location-id="${locationId}"]`);
    if (container) {
      container.remove();
    }
  }

  /**
   * Show reindex progress modal (public entry point for ViewDetails button).
   * @param {string} locationName
   * @param {string} jobId
   */
  showReindexProgress(locationName, jobId) {
    this._showReindexProgress(locationName, jobId);
  }

  /**
   * Update inline progress in location card (or create if missing).
   * @param {string} locationId
   * @param {Object} status
   */
  updateInlineProgress(locationId, status) {
    const activeJobs = this.getActiveReindexJobs();
    const activeJob = activeJobs[locationId];
    if (!activeJob) return;

    let container = document.querySelector(`.inline-reindex-progress[data-location-id="${locationId}"]`);

    if (!container) {
      const progressContainerEl = document.querySelector(`.inline-progress-container[data-location-id="${locationId}"]`);
      if (progressContainerEl) {
        // BUG 3 FIX: Clean up any previous inline progress listeners before recreating
        this._cleanupInlineProgressListeners(locationId);

        progressContainerEl.innerHTML = `
          <div class="inline-reindex-progress" data-location-id="${locationId}">
            <div class="inline-reindex-header">
              <div class="inline-reindex-title">
                <i class="fas fa-cog fa-spin"></i>
                <span>Reindexing in progress...</span>
              </div>
              <button class="inline-view-details-btn" data-job-id="${activeJob.jobId}" data-location-name="${this.escapeHtml(activeJob.locationName)}">
                View Details
              </button>
            </div>
            <div class="inline-progress-bar">
              <div class="inline-progress-fill" style="width: 0%"></div>
            </div>
            <div class="inline-reindex-stats">Initializing...</div>
          </div>
        `;
        container = progressContainerEl.querySelector('.inline-reindex-progress');

        // BUG 3 FIX: Track ViewDetails button listener
        const viewDetailsBtn = container.querySelector('.inline-view-details-btn');
        if (viewDetailsBtn) {
          const handler = () => {
            const jobId = viewDetailsBtn.getAttribute('data-job-id');
            const locationName = viewDetailsBtn.getAttribute('data-location-name');
            if (jobId) {
              this._showReindexProgress(locationName, jobId);
            }
          };
          viewDetailsBtn.addEventListener('click', handler);

          if (!this._inlineProgressListeners.has(locationId)) {
            this._inlineProgressListeners.set(locationId, []);
          }
          this._inlineProgressListeners.get(locationId).push({
            element: viewDetailsBtn,
            event: 'click',
            handler,
          });
        }
      }
    }

    if (!container) return;

    const fillEl = container.querySelector('.inline-progress-fill');
    if (fillEl) {
      fillEl.style.width = `${status.progress_percent || 0}%`;
    }

    const statsEl = container.querySelector('.inline-reindex-stats');
    if (statsEl) {
      const phaseText = status.progress_phase || 'processing';
      const fileStats = `${status.files_scanned || 0} / ${status.files_total || 0} files`;
      const chunkStats = `${status.chunks_processed || 0} chunks`;
      statsEl.textContent = `${phaseText} • ${fileStats} • ${chunkStats}`;
    }
  }

  // ===========================================================================
  // Dispose
  // ===========================================================================

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    // 1. Stop all polling loops
    for (const [locationId, stopFlag] of this._activePolls.entries()) {
      this.logger.info(`[ReindexJobController] Stopping polling loop for location ${locationId}`);
      stopFlag.value = true;
    }
    this._activePolls.clear();

    // 2. Remove reindex modal listeners
    this._clearReindexModalListeners();

    // 3. Remove orphaned modal from DOM
    const modal = document.getElementById('reindex-progress-modal');
    if (modal) modal.remove();

    // 4. Remove minimized bar
    this._removeMinimizedBar();

    // 5. Disable app-close guard
    this._disableCloseGuard();

    // 6. Clean up all inline progress listeners (BUG 3 FIX)
    for (const [locationId] of this._inlineProgressListeners) {
      this._cleanupInlineProgressListeners(locationId);
    }
    this._inlineProgressListeners.clear();

    // 7. Clear caches
    this._activeJobsCache.clear();

    // 8. Null closures
    this.endpoint = null;
    this.getActiveReindexJobs = null;
    this.setActiveReindexJob = null;
    this.deleteActiveReindexJob = null;
    this.getLocations = null;
    this.loadLocations = null;
    this.showSuccess = null;
    this.showError = null;
    this.escapeHtml = null;
  }

  // ===========================================================================
  // Private — Polling
  // ===========================================================================

  async _pollReindexProgress(jobId, locationName, locationId) {
    const pollInterval = 2000;

    // Guard: stop existing poll for this job before starting a new one
    const existingFlag = this._activePolls.get(jobId);
    if (existingFlag) {
      existingFlag.value = true;
    }

    const stopFlag = { value: false };
    this._activePolls.set(jobId, stopFlag);

    try {
      while (!stopFlag.value && !this._isDisposed) {
        const status = await this.endpoint.getReindexJobStatus(jobId);
        
        // Guard against async state clobbering: if poll was superseded or disposed during await, bail immediately
        if (stopFlag.value || this._isDisposed) return;
        
        // Cache last status for immediate UI population on modal reopen
        this._lastStatus.set(locationId, status);

        this._updateReindexProgress(status);
        this.updateInlineProgress(locationId, status);

        if (status.status === 'completed') {
          this.logger.info(`[ReindexJobController] Reindex completed for ${locationName}`);

          // UX FIX: Ensure UI shows 100% and 'Completed!' immediately
          this._updateReindexProgress(status);
          
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (this._isDisposed) return;

          this._hideReindexProgress();
          this.removeInlineProgress(locationId);
          this.deleteActiveReindexJob(locationId);

          this.showSuccess(
            `Reindex completed for ${locationName}!\n` +
            `Indexed ${status.files_total} files, ${status.chunks_processed} chunks`
          );

          await this.loadLocations(true);
          break;

        } else if (status.status === 'failed') {
          this._hideReindexProgress();
          this.removeInlineProgress(locationId);
          this.deleteActiveReindexJob(locationId);
          this.showError(`Reindex failed: ${status.error_message || 'Unknown error'}`);
          await this.loadLocations(true);
          break;

        } else if (status.status === 'cancelled') {
          this._hideReindexProgress();
          this.removeInlineProgress(locationId);
          this.deleteActiveReindexJob(locationId);
          this.showError('Reindex was cancelled');
          await this.loadLocations(true);
          break;

        } else if (status.status === 'stopped') {
          this._hideReindexProgress();
          this.removeInlineProgress(locationId);
          this.deleteActiveReindexJob(locationId);
          this.showSuccess('Reindex stopped. Progress saved.');
          await this.loadLocations(true);
          break;

        } else {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
      }
    } catch (error) {
      // DISPOSAL GUARD: If dispose() ran during an in-flight HTTP call, the
      // closures (showError, deleteActiveReindexJob, loadLocations) are nulled.
      // Calling them would throw TypeError, masking the original error.
      if (this._isDisposed) return;
      
      this._hideReindexProgress();
      this.deleteActiveReindexJob(locationId);
      this.logger.error('[ReindexJobController] Polling failed:', error);
      this.showError(`Progress tracking failed: ${error.message}`);
      await this.loadLocations(true);
    } finally {
      // Only delete if we STILL own this poll. Another call might have overwritten it.
      if (this._activePolls.get(jobId) === stopFlag) {
        this._activePolls.delete(jobId);
      }
    }
  }

  // ===========================================================================
  // Private — Modal UI
  // ===========================================================================

  _showReindexProgress(locationName, jobId) {
    this._hideReindexProgress();
    this._removeMinimizedBar();

    // Reset estimation state only if job changed
    if (this._estimation.jobId !== jobId) {
      this._estimation = {
        jobId: jobId,
        startTime: Date.now(),
        lastPollTime: null,
        lastFilesScanned: 0,
        speedEMA: 0,
        speedSamples: 0,
      };
    }
    this._isMinimized = false;

    // Enable app-close guard
    this._enableCloseGuard();

    const modal = document.createElement('div');
    modal.className = 'reindex-progress-modal';
    modal.id = 'reindex-progress-modal';
    modal.innerHTML = `
      <div class="reindex-progress-overlay"></div>
      <div class="reindex-progress-content">
        <div class="reindex-progress-icon">
          <i class="fas fa-layer-group"></i>
        </div>
        <h3>Reindexing ${this.escapeHtml(locationName)}</h3>
        <div class="reindex-progress-bar">
          <div class="reindex-progress-bar-fill" id="reindex-progress-fill" style="width: 0%"></div>
        </div>
        <div class="reindex-progress-headline">
          <span class="reindex-progress-percent" id="reindex-progress-percent">0%</span>
          <span class="reindex-progress-eta" id="reindex-progress-eta">Estimating time remaining...</span>
        </div>
        <p class="reindex-progress-phase" id="reindex-progress-phase">Initializing...</p>
        <div class="reindex-detail-grid" id="reindex-detail-grid">
          <div class="reindex-detail-item">
            <span class="detail-label">Current File</span>
            <span class="detail-value" id="detail-current-file">--</span>
          </div>
          <div class="reindex-detail-item">
            <span class="detail-label">Speed</span>
            <span class="detail-value" id="detail-speed">--</span>
          </div>
          <div class="reindex-detail-item">
            <span class="detail-label">Files</span>
            <span class="detail-value" id="detail-files">0 / 0</span>
          </div>
          <div class="reindex-detail-item">
            <span class="detail-label">Chunks</span>
            <span class="detail-value" id="detail-chunks">0</span>
          </div>
          <div class="reindex-detail-item">
            <span class="detail-label">Data Processed</span>
            <span class="detail-value" id="detail-data-size">0 KB</span>
          </div>
          <div class="reindex-detail-item">
            <span class="detail-label">Elapsed</span>
            <span class="detail-value" id="detail-elapsed">0s</span>
          </div>
        </div>
        <p class="reindex-progress-hint">
          <i class="fas fa-info-circle"></i> Indexing continues in the background if you close this dialog
        </p>
        <div class="reindex-controls">
          <button class="reindex-ctrl-btn btn-pause" id="reindex-pause-btn" data-job-id="${this.escapeHtml(jobId)}">
            <i class="fas fa-pause"></i> Pause
          </button>
          <button class="reindex-ctrl-btn btn-stop" id="reindex-stop-btn" data-job-id="${this.escapeHtml(jobId)}">
            <i class="fas fa-stop"></i> Stop
          </button>
          <button class="reindex-ctrl-btn btn-cancel" id="reindex-cancel-btn" data-job-id="${this.escapeHtml(jobId)}">
            <i class="fas fa-times"></i> Cancel
          </button>
          <button class="reindex-ctrl-btn btn-close" id="reindex-close-btn">
            <i class="fas fa-check"></i> Done
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    this._clearReindexModalListeners();
    const pauseBtn = document.getElementById('reindex-pause-btn');
    const stopBtn = document.getElementById('reindex-stop-btn');
    const cancelBtn = document.getElementById('reindex-cancel-btn');
    const closeBtn = document.getElementById('reindex-close-btn');
    const overlay = modal.querySelector('.reindex-progress-overlay');

    const trackModal = (el, evt, handler) => {
      if (!el) return;
      el.addEventListener(evt, handler);
      this._reindexModalListeners.push({ element: el, event: evt, handler });
    };

    this._reindexPauseHandler = () => this._pauseReindex(jobId);
    trackModal(pauseBtn, 'click', this._reindexPauseHandler);
    trackModal(stopBtn, 'click', () => this._stopReindex(jobId));
    trackModal(cancelBtn, 'click', () => this._cancelReindex(jobId));
    trackModal(closeBtn, 'click', () => this._hideReindexProgress());
    trackModal(overlay, 'click', () => this._hideReindexProgress());

    // UX FIX: If we have last known status, populate modal immediately to avoid 0% flash
    const lastStatus = this._lastStatus.get(this._estimation.jobId) || [...this._lastStatus.values()].find(s => s.job_id === jobId);
    if (lastStatus) {
      this._updateReindexProgress(lastStatus);
    } else {
      // Fallback: Check if location is already running and show 'Fetching...'
      const locations = this.getLocations();
      const location = locations.find(l => l.id === this._estimation.jobId || l.location_name === locationName);
      if (location && location.last_scan_status === 'running') {
        const phaseEl = document.getElementById('reindex-progress-phase');
        if (phaseEl) phaseEl.textContent = 'Fetching current status...';
      }
    }

    requestAnimationFrame(() => {
      modal.style.opacity = '1';
    });
  }

  _updateReindexProgress(status) {
    const progress = status.progress_percent || 0;
    const filesScanned = status.files_scanned || 0;
    const filesTotal = status.files_total || 0;
    const chunksProcessed = status.chunks_processed || 0;

    // --- Estimation engine (EMA-based) ---
    const now = Date.now();
    let etaText = 'Estimating time remaining...';
    let speedText = '--';

    if (this._estimation.lastPollTime && filesScanned > this._estimation.lastFilesScanned) {
      const elapsedSec = (now - this._estimation.lastPollTime) / 1000;
      const filesDelta = filesScanned - this._estimation.lastFilesScanned;
      const currentSpeed = elapsedSec > 0 ? filesDelta / elapsedSec : 0;

      if (currentSpeed > 0) {
        const alpha = 0.3; // Lower = smoother/more stable
        if (this._estimation.speedSamples === 0) {
          this._estimation.speedEMA = currentSpeed;
        } else {
          this._estimation.speedEMA = alpha * currentSpeed + (1 - alpha) * this._estimation.speedEMA;
        }
        this._estimation.speedSamples++;

        speedText = `${this._estimation.speedEMA.toFixed(1)} files/sec`;

        const remaining = filesTotal - filesScanned;
        if (remaining > 0 && this._estimation.speedEMA > 0) {
          const etaSeconds = remaining / this._estimation.speedEMA;
          etaText = this._formatTimeRemaining(etaSeconds);
        } else if (remaining <= 0) {
          etaText = 'Finishing up...';
        }
      }
    } else if (filesTotal > 0 && filesScanned === 0) {
      etaText = 'Starting — may take 20-40 minutes for large directories';
    }

    this._estimation.lastPollTime = now;
    this._estimation.lastFilesScanned = filesScanned;

    // --- Elapsed time ---
    let elapsedText = '';
    if (this._estimation.startTime) {
      const elapsedMs = now - this._estimation.startTime;
      elapsedText = this._formatElapsed(elapsedMs);
    }

    // --- Data size estimate (rough: ~4KB per chunk average) ---
    const dataSizeKB = chunksProcessed * 4;
    const dataSizeText = dataSizeKB >= 1024
      ? `${(dataSizeKB / 1024).toFixed(1)} MB`
      : `${dataSizeKB} KB`;

    // --- Phase label ---
    const phaseText = {
      'initializing': 'Initializing...',
      'scanning': 'Scanning files...',
      'processing': 'Processing documents...',
      'indexing': 'Building search index...',
      'finalizing': 'Finalizing...',
      'completed': 'Completed!',
    }[status.progress_phase] || status.progress_phase || 'Processing...';

    // --- Current file (truncated) ---
    const currentFile = status.current_file
      ? this._truncatePath(status.current_file, 50)
      : (filesScanned > 0 ? 'Processing...' : '--');

    // --- Update full modal elements ---
    const fillEl = document.getElementById('reindex-progress-fill');
    if (fillEl) fillEl.style.width = `${progress}%`;

    const percentEl = document.getElementById('reindex-progress-percent');
    if (percentEl) percentEl.textContent = `${progress}%`;

    const etaEl = document.getElementById('reindex-progress-eta');
    if (etaEl) etaEl.textContent = etaText;

    const phaseEl = document.getElementById('reindex-progress-phase');
    if (phaseEl) phaseEl.textContent = phaseText;

    const currentFileEl = document.getElementById('detail-current-file');
    if (currentFileEl) currentFileEl.textContent = currentFile;

    const speedEl = document.getElementById('detail-speed');
    if (speedEl) speedEl.textContent = speedText;

    const filesEl = document.getElementById('detail-files');
    if (filesEl) filesEl.textContent = `${filesScanned.toLocaleString()} / ${filesTotal.toLocaleString()}`;

    const chunksEl = document.getElementById('detail-chunks');
    if (chunksEl) chunksEl.textContent = chunksProcessed.toLocaleString();

    const dataSizeEl = document.getElementById('detail-data-size');
    if (dataSizeEl) dataSizeEl.textContent = dataSizeText;

    const elapsedEl = document.getElementById('detail-elapsed');
    if (elapsedEl) elapsedEl.textContent = elapsedText;

    // --- Update minimized bar (if active) ---
    this._updateMinimizedBar(progress, etaText);
  }

  // ===========================================================================
  // Private — Time Formatting
  // ===========================================================================

  _formatTimeRemaining(seconds) {
    if (seconds < 60) return 'Less than a minute remaining';
    if (seconds < 120) return 'About a minute remaining';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `About ${minutes} minutes remaining`;
    const hours = Math.floor(minutes / 60);
    const remainMin = minutes % 60;
    if (remainMin === 0) return `About ${hours} hour${hours > 1 ? 's' : ''} remaining`;
    return `About ${hours}h ${remainMin}m remaining`;
  }

  _formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return `${min}m ${sec}s`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}h ${remMin}m`;
  }

  _truncatePath(fullPath, maxLen) {
    if (!fullPath || fullPath.length <= maxLen) return fullPath || '--';
    const parts = fullPath.split('/');
    const fileName = parts.pop();
    if (fileName.length >= maxLen - 5) return '...' + fileName.slice(-(maxLen - 3));
    return '.../' + parts.slice(-2).join('/') + '/' + fileName;
  }

  _hideReindexProgress() {
    this._clearReindexModalListeners();
    this._removeMinimizedBar();
    this._disableCloseGuard();
    this._isMinimized = false;
    this._hasActiveIndexing = false;

    const modal = document.getElementById('reindex-progress-modal');
    if (modal) {
      modal.style.opacity = '0';
      setTimeout(() => modal.remove(), 200);
    }
  }

  _minimizeReindexModal(locationName, jobId) {
    this._isMinimized = true;

    // Hide the full modal
    this._clearReindexModalListeners();
    const modal = document.getElementById('reindex-progress-modal');
    if (modal) {
      modal.style.opacity = '0';
      setTimeout(() => modal.remove(), 200);
    }

    // Create floating minimized bar
    this._removeMinimizedBar();
    const bar = document.createElement('div');
    bar.className = 'reindex-minimized-bar';
    bar.id = 'reindex-minimized-bar';
    bar.title = 'Double-click to expand progress details';
    bar.innerHTML = `
      <div class="minimized-bar-content">
        <i class="fas fa-layer-group fa-spin minimized-bar-icon"></i>
        <span class="minimized-bar-text">Reindexing...</span>
        <span class="minimized-bar-percent" id="minimized-bar-percent">0%</span>
        <span class="minimized-bar-sep">|</span>
        <span class="minimized-bar-eta" id="minimized-bar-eta">Estimating...</span>
      </div>
      <div class="minimized-bar-progress">
        <div class="minimized-bar-fill" id="minimized-bar-fill" style="width: 0%"></div>
      </div>
    `;
    document.body.appendChild(bar);
    this._minimizedBarEl = bar;

    // Track listeners
    const dblClickHandler = () => {
      this._isMinimized = false;
      this._removeMinimizedBar();
      this._showReindexProgress(locationName, jobId);
    };
    bar.addEventListener('dblclick', dblClickHandler);
    this._minimizedBarListeners.push({ element: bar, event: 'dblclick', handler: dblClickHandler });

    // Animate in
    requestAnimationFrame(() => {
      bar.classList.add('visible');
    });
  }

  _restoreReindexModal(locationName, jobId) {
    this._isMinimized = false;
    this._removeMinimizedBar();
    this._showReindexProgress(locationName, jobId);
  }

  _removeMinimizedBar() {
    for (const { element, event, handler } of this._minimizedBarListeners) {
      try { element?.removeEventListener(event, handler); } catch (_) { /* noop */ }
    }
    this._minimizedBarListeners = [];

    const bar = document.getElementById('reindex-minimized-bar');
    if (bar) bar.remove();
    this._minimizedBarEl = null;
  }

  _updateMinimizedBar(progress, etaText) {
    if (!this._isMinimized) return;

    const percentEl = document.getElementById('minimized-bar-percent');
    if (percentEl) percentEl.textContent = `${progress}%`;

    const etaEl = document.getElementById('minimized-bar-eta');
    if (etaEl) etaEl.textContent = etaText;

    const fillEl = document.getElementById('minimized-bar-fill');
    if (fillEl) fillEl.style.width = `${progress}%`;
  }

  // ===========================================================================
  // Private — App Close Guard
  // ===========================================================================

  _enableCloseGuard() {
    this._hasActiveIndexing = true;
    if (!this._beforeUnloadHandler) {
      this._beforeUnloadHandler = (e) => {
        if (this._hasActiveIndexing) {
          const msg = 'Indexing is in progress. Closing now may corrupt your search index.';
          e.returnValue = msg;
          return msg;
        }
      };
      window.addEventListener('beforeunload', this._beforeUnloadHandler);
    }
  }

  _disableCloseGuard() {
    this._hasActiveIndexing = false;
    if (this._beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler);
      this._beforeUnloadHandler = null;
    }
  }

  // ===========================================================================
  // Private — Job Controls (pause/resume/stop/cancel)
  // ===========================================================================

  /**
   * BUG 1 FIX: After swapping the pause/resume handler, update _reindexModalListeners
   * so _clearReindexModalListeners() always removes the CURRENT handler.
   */
  _updatePauseHandlerInTracking(pauseBtn, newHandler) {
    // Find and update the existing entry for the pause button
    const entry = this._reindexModalListeners.find(e => e.element === pauseBtn);
    if (entry) {
      entry.handler = newHandler;
    } else {
      // Safety: if entry was somehow lost, track the new one
      this._reindexModalListeners.push({ element: pauseBtn, event: 'click', handler: newHandler });
    }
  }

  async _pauseReindex(jobId) {
    try {
      this.logger.info(`[ReindexJobController] Pausing job ${jobId}`);
      await this.endpoint.pauseReindexJob(jobId);

      const pauseBtn = document.getElementById('reindex-pause-btn');
      if (pauseBtn && this._reindexPauseHandler) {
        pauseBtn.removeEventListener('click', this._reindexPauseHandler);
        pauseBtn.innerHTML = '<i class="fas fa-play"></i> Resume';
        pauseBtn.classList.remove('btn-pause');
        pauseBtn.classList.add('btn-resume');
        this._reindexPauseHandler = () => this._resumeReindex(jobId);
        pauseBtn.addEventListener('click', this._reindexPauseHandler);

        // BUG 1 FIX: Keep _reindexModalListeners in sync with the new handler
        this._updatePauseHandlerInTracking(pauseBtn, this._reindexPauseHandler);
      }

      const phaseEl = document.getElementById('reindex-progress-phase');
      if (phaseEl) phaseEl.textContent = 'Paused (checkpoint saved)';
    } catch (error) {
      this.logger.error('[ReindexJobController] Failed to pause job:', error);
      this.showError(`Failed to pause: ${error.message}`);
    }
  }

  async _resumeReindex(jobId) {
    try {
      this.logger.info(`[ReindexJobController] Resuming job ${jobId}`);
      await this.endpoint.resumeReindexJob(jobId);

      const resumeBtn = document.getElementById('reindex-pause-btn');
      if (resumeBtn && this._reindexPauseHandler) {
        resumeBtn.removeEventListener('click', this._reindexPauseHandler);
        resumeBtn.innerHTML = '<i class="fas fa-pause"></i> Pause';
        resumeBtn.classList.remove('btn-resume');
        resumeBtn.classList.add('btn-pause');
        this._reindexPauseHandler = () => this._pauseReindex(jobId);
        resumeBtn.addEventListener('click', this._reindexPauseHandler);

        // BUG 1 FIX: Keep _reindexModalListeners in sync with the new handler
        this._updatePauseHandlerInTracking(resumeBtn, this._reindexPauseHandler);
      }

      const phaseEl = document.getElementById('reindex-progress-phase');
      if (phaseEl) phaseEl.textContent = 'Resuming...';
    } catch (error) {
      this.logger.error('[ReindexJobController] Failed to resume job:', error);
      this.showError(`Failed to resume: ${error.message}`);
    }
  }

  async _stopReindex(jobId) {
    try {
      const confirmed = await ConfirmDialog.confirm({
        title: 'Stop indexing',
        message: 'Stop indexing? Progress will be saved and you can resume later.',
        confirmText: 'Stop',
        cancelText: 'Keep running',
      });
      if (!confirmed) return;

      this.logger.info(`[ReindexJobController] Stopping job ${jobId}`);
      await this.endpoint.stopReindexJob(jobId);

      this._hideReindexProgress();
      this.showSuccess('Reindex stopped. Progress saved - you can resume later.');
      await this.loadLocations(true);
    } catch (error) {
      this.logger.error('[ReindexJobController] Failed to stop job:', error);
      this.showError(`Failed to stop: ${error.message}`);
    }
  }

  async _cancelReindex(jobId) {
    try {
      const confirmed = await ConfirmDialog.confirm({
        title: 'Cancel indexing',
        message: 'Cancel indexing? All progress will be lost.',
        confirmText: 'Cancel indexing',
        cancelText: 'Keep running',
        variant: 'danger',
      });
      if (!confirmed) return;

      this.logger.info(`[ReindexJobController] Cancelling job ${jobId}`);
      await this.endpoint.cancelReindexJob(jobId);

      this._hideReindexProgress();
      this.showError('Reindex cancelled - progress discarded');
    } catch (error) {
      this.logger.error('[ReindexJobController] Failed to cancel job:', error);
      this.showError(`Failed to cancel: ${error.message}`);
    }
  }

  // ===========================================================================
  // Private — Listener Cleanup
  // ===========================================================================

  _clearReindexModalListeners() {
    for (const { element, event, handler } of this._reindexModalListeners) {
      try {
        if (element) element.removeEventListener(event, handler);
      } catch (_) { /* element may already be removed */ }
    }
    this._reindexModalListeners = [];
    this._reindexPauseHandler = null;
  }

  /** BUG 3 FIX: Clean up tracked inline progress listeners for a location. */
  _cleanupInlineProgressListeners(locationId) {
    const listeners = this._inlineProgressListeners.get(locationId);
    if (listeners) {
      for (const { element, event, handler } of listeners) {
        try {
          if (element) element.removeEventListener(event, handler);
        } catch (_) { /* element may already be removed */ }
      }
      this._inlineProgressListeners.delete(locationId);
    }
  }
}

module.exports = ReindexJobController;
