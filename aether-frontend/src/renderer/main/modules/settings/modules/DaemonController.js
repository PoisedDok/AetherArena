'use strict';

/**
 * @.architecture
 * Incoming: FileIndexingManager orchestrator via closures --- {method calls, state queries}
 * Processing: manage daemon lifecycle, render status banner, handle control errors --- {3 jobs: JOB_HTTP_REQUEST, JOB_RENDER_UI, JOB_POLL_STATUS}
 * Outgoing: Endpoint API, DOM banner elements --- {HTTP requests, HTML elements}
 */

const ConfirmDialog = require('../../../../shared/components/ConfirmDialog');

class DaemonController {
  /**
   * @param {Object} options
   * @param {Object} options.endpoint - API endpoint (FileIndexingApi)
   * @param {Function} options.getElements - () => { enableToggle, addButton, ... }
   * @param {Function} options.getIsEnabled - () => boolean
   * @param {Function} options.setIsEnabled - (val) => void
   * @param {Function} options.getDaemonStatus - () => status object
   * @param {Function} options.setDaemonStatus - (status) => void
   * @param {Function} options.loadLocations - (forceRefresh?) => Promise
   * @param {Function} options.showSuccess - (message) => void
   * @param {Function} options.showError - (message) => void
   * @param {Object} options.logger
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint;
    this.getElements = options.getElements;
    this.getIsEnabled = options.getIsEnabled;
    this.setIsEnabled = options.setIsEnabled;
    this.getDaemonStatus = options.getDaemonStatus;
    this.setDaemonStatus = options.setDaemonStatus;
    this.loadLocations = options.loadLocations;
    this.showSuccess = options.showSuccess;
    this.showError = options.showError;
    this.logger = options.logger || console;

    this._isDisposed = false;

    // State
    this._isChangingState = false;
    this._daemonStartRequestedAt = 0;
    this._daemonControlsLocked = false;

    // Banner DOM cache
    this._daemonBannerListeners = [];
    this._daemonBannerButtons = null;

    // BUG 2 FIX: Track restart timer so dispose() can clear it
    this._restartTimerId = null;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Update enabled state — actually starts/stops daemon via API.
   */
  async updateEnabledState() {
    if (this._isDisposed) return;
    if (this._isChangingState) return;

    const elements = this.getElements();
    const isEnabled = this.getIsEnabled();

    try {
      this._isChangingState = true;

      if (isEnabled) {
        this.logger.info('[DaemonController] Starting daemon...');
        this._daemonStartRequestedAt = Date.now();
        const result = await this.endpoint.startFileIndexingDaemon();

        if (result.success) {
          this.showSuccess('Daemon started successfully');
          this.setDaemonStatus({ running: false, error: null, _ui_state: 'starting' });
          this.renderDaemonBanner();
          await this._awaitDaemonStatusTransition({ targetRunning: true, timeoutMs: 15000, pollIntervalMs: 750 });
          await this.loadDaemonStatus();
          await this.loadLocations(true);
        } else {
          this.showError(result.message || 'Failed to start daemon');
          if (elements.enableToggle) {
            elements.enableToggle.checked = false;
            this.setIsEnabled(false);
          }
        }
      } else {
        const confirmed = await ConfirmDialog.confirm({
          title: 'Stop indexing daemon',
          message: 'Stop the file indexing daemon?\n\nThis will pause all file indexing and disable semantic search.',
          confirmText: 'Stop daemon',
          cancelText: 'Keep running',
          variant: 'danger',
        });
        if (!confirmed) {
          if (elements.enableToggle) {
            elements.enableToggle.checked = true;
            this.setIsEnabled(true);
          }
          return;
        }

        this.logger.info('[DaemonController] Stopping daemon...');
        if (elements.enableToggle) {
          elements.enableToggle.disabled = true;
        }

        const result = await this.endpoint.stopFileIndexingDaemon();

        if (result.success) {
          this.showSuccess('Daemon stopped successfully');
          await this._awaitDaemonStatusTransition({ targetRunning: false, timeoutMs: 15000, pollIntervalMs: 750 });
          await this.loadDaemonStatus();
          await this.loadLocations(true);
          if (elements.enableToggle) {
            elements.enableToggle.disabled = false;
          }
        } else {
          this.showError(result.message || 'Failed to stop daemon');
          if (elements.enableToggle) {
            elements.enableToggle.checked = true;
            elements.enableToggle.disabled = false;
            this.setIsEnabled(true);
          }
        }
      }

      // Update UI state (skip if disposed during async operations above)
      if (!this._isDisposed) {
        const card = elements.addButton?.closest('.settings-card');
        if (card) {
          card.style.opacity = this.getIsEnabled() ? '1' : '0.6';
          if (elements.addButton) {
            elements.addButton.disabled = !this.getIsEnabled();
          }
        }
      }

    } catch (error) {
      // Guard: closures are null after dispose — do not access them
      if (this._isDisposed) return;
      this.logger.error('[DaemonController] Failed to update daemon state:', error);
      const handled = this._handleDaemonControlError(error);
      if (!handled) {
        this.showError(`Failed to ${this.getIsEnabled() ? 'start' : 'stop'} daemon: ${error.message}`);
      }
      if (elements.enableToggle) {
        const currentEnabled = this.getIsEnabled();
        elements.enableToggle.checked = !currentEnabled;
        elements.enableToggle.disabled = false;
        this.setIsEnabled(!currentEnabled);
      }
    } finally {
      this._isChangingState = false;
    }
  }

  /**
   * Load daemon status from API and sync toggle.
   */
  async loadDaemonStatus() {
    if (this._isDisposed) return;
    try {
      const status = await this.endpoint.getFileIndexingDaemonStatus();
      if (this._isDisposed) return; // dispose may have fired during await
      this.setDaemonStatus(status);

      if (!status.running && this._daemonStartRequestedAt) {
        const ageMs = Date.now() - this._daemonStartRequestedAt;
        if (ageMs >= 0 && ageMs < 20000) {
          this.setDaemonStatus({ ...status, _ui_state: 'starting' });
        }
      }

      const elements = this.getElements();
      if (!this._isChangingState && elements.enableToggle) {
        const shouldBeEnabled = status.running;
        if (elements.enableToggle.checked !== shouldBeEnabled) {
          elements.enableToggle.checked = shouldBeEnabled;
          this.setIsEnabled(shouldBeEnabled);
        }
      }

      this.renderDaemonBanner();
    } catch (error) {
      if (this._isDisposed) return; // closures null after dispose — bail cleanly
      this.logger.warn('[DaemonController] Failed to load daemon status:', error);
      this.setDaemonStatus({ running: false, error: error.message });
      this.renderDaemonBanner();
    }
  }

  /**
   * Render daemon status banner (create on first render, update DOM directly after).
   */
  renderDaemonBanner() {
    if (this._isDisposed) return;
    const elements = this.getElements();
    const daemonStatus = this.getDaemonStatus();

    let banner = document.getElementById('file-indexing-daemon-banner');
    const isFirstRender = !banner;

    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'file-indexing-daemon-banner';
      banner.className = 'daemon-status-banner';

      const slot = document.getElementById('file-indexing-daemon-banner-slot');
      if (slot) {
        slot.appendChild(banner);
      } else {
        const cardContent = elements.enableToggle?.closest('.settings-card')?.querySelector('.card-content');
        if (cardContent) {
          cardContent.insertBefore(banner, cardContent.firstChild);
        }
      }
    }

    if (!daemonStatus) {
      banner.style.display = 'none';
      return;
    }

    const uiState = daemonStatus._ui_state;
    const isRunning = daemonStatus.running === true;
    const isStarting = uiState === 'starting' && !isRunning;
    const statusIcon = isRunning ? 'fa-check-circle' : (isStarting ? 'fa-spinner fa-spin' : 'fa-exclamation-triangle');
    const statusClass = isRunning ? 'daemon-running' : (isStarting ? 'daemon-starting' : 'daemon-stopped');
    const statusText = isRunning ? 'Running' : (isStarting ? 'Starting\u2026' : 'Stopped');
    const uptime = daemonStatus.uptime_seconds ? this._formatUptime(daemonStatus.uptime_seconds) : 'N/A';

    banner.className = `daemon-status-banner ${statusClass}`;

    if (isFirstRender) {
      banner.innerHTML = `
        <div class="daemon-banner-content">
          <div class="daemon-banner-left">
            <i class="fas ${statusIcon}" data-daemon-icon></i>
            <span class="daemon-banner-label">File Indexing Daemon:</span>
            <span class="daemon-banner-status" data-daemon-status>${statusText}</span>
            <span class="daemon-banner-uptime" data-daemon-uptime style="display: ${isRunning ? 'inline' : 'none'}">Uptime: ${uptime}</span>
          </div>
          <div class="daemon-banner-right">
            <button class="daemon-banner-btn" id="daemon-restart-btn" title="Restart daemon">
              <i class="fas fa-sync-alt"></i> Restart
            </button>
          </div>
        </div>
      `;

      this._daemonBannerButtons = {
        restart: banner.querySelector('#daemon-restart-btn'),
      };

      const restartHandler = () => this._restartDaemon();
      if (this._daemonBannerButtons.restart) {
        this._daemonBannerButtons.restart.addEventListener('click', restartHandler);
        this._daemonBannerListeners.push({
          element: this._daemonBannerButtons.restart,
          event: 'click',
          handler: restartHandler,
        });
      }
    } else {
      const icon = banner.querySelector('[data-daemon-icon]');
      const statusEl = banner.querySelector('[data-daemon-status]');
      const uptimeEl = banner.querySelector('[data-daemon-uptime]');

      if (icon) icon.className = `fas ${statusIcon}`;
      if (statusEl) statusEl.textContent = statusText;
      if (uptimeEl) {
        if (isRunning) {
          uptimeEl.textContent = `Uptime: ${uptime}`;
          uptimeEl.style.display = 'inline';
        } else {
          uptimeEl.style.display = 'none';
        }
      }
    }

    if (this._daemonControlsLocked && this._daemonBannerButtons?.restart) {
      this._daemonBannerButtons.restart.disabled = true;
      this._daemonBannerButtons.restart.title = 'Daemon controls disabled by backend configuration';
    }

    banner.style.display = 'flex';
  }

  // ===========================================================================
  // Dispose
  // ===========================================================================

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    // 1. BUG 2 FIX: Clear tracked restart timer
    if (this._restartTimerId !== null) {
      clearTimeout(this._restartTimerId);
      this._restartTimerId = null;
    }

    // 2. Remove banner listeners
    for (const { element, event, handler } of this._daemonBannerListeners) {
      try {
        if (element) element.removeEventListener(event, handler);
      } catch (_) { /* element may already be removed */ }
    }
    this._daemonBannerListeners = [];
    this._daemonBannerButtons = null;

    // 3. Null closures
    this.endpoint = null;
    this.getElements = null;
    this.getIsEnabled = null;
    this.setIsEnabled = null;
    this.getDaemonStatus = null;
    this.setDaemonStatus = null;
    this.loadLocations = null;
    this.showSuccess = null;
    this.showError = null;
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  async _awaitDaemonStatusTransition({ targetRunning, timeoutMs, pollIntervalMs }) {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      if (this._isDisposed) return; // exit cleanly if disposed during polling
      try {
        const status = await this.endpoint.getFileIndexingDaemonStatus();
        if (status && status.running === targetRunning) {
          return;
        }
      } catch (error) {
        // Ignore transient errors while the daemon is coming up/down.
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  async _restartDaemon() {
    if (this._isDisposed) return;
    const confirmed = await ConfirmDialog.confirm({
      title: 'Restart daemon',
      message: 'Restart the file indexing daemon?\n\nThis will briefly pause all indexing operations.',
      confirmText: 'Restart',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;

    try {
      const restartBtn = document.querySelector('#daemon-restart-btn');
      if (restartBtn) {
        restartBtn.disabled = true;
        restartBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Restarting...';
      }

      const result = await this.endpoint.restartFileIndexingDaemon();

      if (result.success) {
        this.showSuccess('Daemon restart requested successfully');

        // BUG 2 FIX: Track the restart timer so dispose() can clear it
        this._restartTimerId = setTimeout(async () => {
          this._restartTimerId = null;
          // Guard against disposed state
          if (!this.endpoint) return;
          try {
            await this.loadDaemonStatus();
            await this.loadLocations();
          } catch (err) {
            this.logger.error('[DaemonController] Post-restart status load failed:', err);
          }
        }, 3000);
      } else {
        this.showError(result.message || 'Restart failed');
      }
    } catch (error) {
      this.logger.error('[DaemonController] Failed to restart daemon:', error);
      if (!this._handleDaemonControlError(error)) {
        this.showError(`Failed to restart daemon: ${error.message}`);
      }
    } finally {
      const restartBtn = document.querySelector('#daemon-restart-btn');
      if (restartBtn) {
        restartBtn.disabled = false;
        restartBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Restart';
      }
    }
  }

  _handleDaemonControlError(error) {
    if (this._isDisposed) return false;
    const status = error?.status || error?.response?.status;
    if (status !== 403) return false;

    this._daemonControlsLocked = true;
    const elements = this.getElements();
    if (elements.enableToggle) {
      elements.enableToggle.disabled = true;
      elements.enableToggle.title = 'Daemon controls blocked by backend security policy';
    }
    if (this._daemonBannerButtons?.restart) {
      this._daemonBannerButtons.restart.disabled = true;
      this._daemonBannerButtons.restart.title = 'Daemon controls blocked by backend security policy';
    }
    this.showError('File indexing daemon controls are blocked by backend security policy (HTTP 403).');
    return true;
  }

  _formatUptime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
}

module.exports = DaemonController;
