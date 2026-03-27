'use strict';

/**
 * @.architecture
 * Incoming: FileIndexingManager orchestrator via closures --- {location data, render triggers}
 * Processing: render/update/remove location cards, manage card listeners, empty state --- {2 jobs: JOB_RENDER_UI, JOB_UPDATE_UI}
 * Outgoing: DOM location card elements --- {HTML elements}
 */

class LocationCardRenderer {
  /**
   * @param {Object} options
   * @param {Function} options.getLocations - () => locations array
   * @param {Function} options.getElements - () => { locationsList, addButton, ... }
   * @param {Function} options.getActiveReindexJobs - () => activeReindexJobs object
   * @param {Function} options.showConfig - (location) => void
   * @param {Function} options.triggerReindex - (locationId, locationName) => void
   * @param {Function} options.toggleLocation - (locationId, enabled) => void
   * @param {Function} options.deleteLocation - (locationId, locationName) => void
   * @param {Function} options.renderInlineProgress - (locationId) => string HTML
   * @param {Function} options.showReindexProgress - (locationName, jobId) => void
   * @param {Function} options.escapeHtml - (text) => string
   * @param {Function} options.formatBytes - (bytes) => string
   * @param {Function} options.formatStatus - (status) => string
   * @param {Object} options.logger
   */
  constructor(options = {}) {
    this.getLocations = options.getLocations;
    this.getElements = options.getElements;
    this.getActiveReindexJobs = options.getActiveReindexJobs;
    this.showConfig = options.showConfig;
    this.triggerReindex = options.triggerReindex;
    this.toggleLocation = options.toggleLocation;
    this.deleteLocation = options.deleteLocation;
    this.renderInlineProgress = options.renderInlineProgress;
    this.showReindexProgress = options.showReindexProgress;
    this.escapeHtml = options.escapeHtml;
    this.formatBytes = options.formatBytes;
    this.formatStatus = options.formatStatus;
    this.logger = options.logger || console;

    this._isDisposed = false;

    // DOM cache
    this._locationCards = new Map(); // Map<locationId, HTMLElement>
    this._locationCardListeners = new Map(); // Map<locationId, Array<{element, event, handler}>>
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Render locations list (diff-based: remove stale, update existing, create new).
   */
  renderLocations() {
    if (this._isDisposed) return;
    const elements = this.getElements();
    const locations = this.getLocations();

    if (!elements.locationsList) return;

    if (locations.length === 0) {
      this._renderEmptyState();
      this.updateAddButtonState();
      return;
    }

    // Clear empty state if present
    const emptyState = elements.locationsList.querySelector('.empty-state');
    if (emptyState) {
      emptyState.remove();
    }

    const currentLocationIds = new Set(locations.map(loc => loc.id));

    // Remove cards and listeners for deleted locations
    for (const [locationId, card] of this._locationCards.entries()) {
      if (!currentLocationIds.has(locationId)) {
        this._cleanupCardListeners(locationId);
        card.remove();
        this._locationCards.delete(locationId);
      }
    }

    // Update or create cards
    locations.forEach(location => {
      let card = this._locationCards.get(location.id);

      if (!card) {
        card = this._createLocationElement(location);
        this._locationCards.set(location.id, card);
        elements.locationsList.appendChild(card);
      } else {
        this._updateLocationCard(card, location);
      }
    });

    this.updateAddButtonState();
  }

  /**
   * Update add button state based on location limits.
   */
  updateAddButtonState() {
    const elements = this.getElements();
    const locations = this.getLocations();
    if (!elements.addButton) return;

    const hasPrimary = locations.some(loc => loc.location_type === 'primary');
    const hasSecondary = locations.some(loc => loc.location_type === 'secondary');

    if (hasPrimary && hasSecondary) {
      elements.addButton.disabled = true;
      elements.addButton.title = 'Maximum locations reached (one primary and one secondary)';
      elements.addButton.style.opacity = '0.5';
      elements.addButton.style.cursor = 'not-allowed';
    } else {
      elements.addButton.disabled = false;
      elements.addButton.title = 'Add Indexing Location';
      elements.addButton.style.opacity = '1';
      elements.addButton.style.cursor = 'pointer';
    }
  }

  // ===========================================================================
  // Dispose
  // ===========================================================================

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    // Remove all card listeners
    for (const [locationId] of this._locationCardListeners) {
      this._cleanupCardListeners(locationId);
    }
    this._locationCardListeners.clear();
    this._locationCards.clear();

    // Null closures
    this.getLocations = null;
    this.getElements = null;
    this.getActiveReindexJobs = null;
    this.showConfig = null;
    this.triggerReindex = null;
    this.toggleLocation = null;
    this.deleteLocation = null;
    this.renderInlineProgress = null;
    this.showReindexProgress = null;
    this.escapeHtml = null;
    this.formatBytes = null;
    this.formatStatus = null;
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  _renderEmptyState() {
    const elements = this.getElements();
    
    // Clear listeners before wiping DOM
    for (const [locationId] of this._locationCardListeners) {
      this._cleanupCardListeners(locationId);
    }
    this._locationCardListeners.clear();
    this._locationCards.clear();

    elements.locationsList.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-folder-open"></i>
        <p>No indexed locations yet</p>
        <p class="empty-state-hint">Click "Add Indexing Location" to get started</p>
      </div>
    `;
  }

  _updateLocationCard(card, location) {
    const statusEl = card.querySelector('.file-location-status');
    if (statusEl) {
      const statusClass = location.enabled ? 'enabled' : 'disabled';
      const statusText = location.enabled ? 'Enabled' : 'Disabled';
      statusEl.className = `file-location-status ${statusClass}`;
      statusEl.textContent = statusText;
    }

    const fileCountEl = card.querySelector('.file-location-stat:nth-child(1) .file-location-stat-value');
    if (fileCountEl) fileCountEl.textContent = location.file_count || 0;

    const chunkCountEl = card.querySelector('.file-location-stat:nth-child(2) .file-location-stat-value');
    if (chunkCountEl) chunkCountEl.textContent = location.chunk_count || 0;

    const indexSizeEl = card.querySelector('.file-location-stat:nth-child(3) .file-location-stat-value');
    if (indexSizeEl) indexSizeEl.textContent = this.formatBytes(location.index_size_bytes || 0);

    const statusIndicatorEl = card.querySelector('.file-location-stat:nth-child(4) .file-location-stat-value');
    if (statusIndicatorEl) {
      statusIndicatorEl.innerHTML = `
        ${['semantic', 'combined'].includes(location.index_mode) ? `<span class="index-badge status-${location.last_scan_status === 'completed' ? 'active' : 'pending'}">[Smart Search: ${location.last_scan_status === 'completed' ? 'Active' : 'Pending'}]</span>` : ''}
        ${['bm25', 'combined'].includes(location.index_mode) ? `<span class="index-badge status-${location.last_scan_status === 'completed' ? 'active' : 'pending'}">[Keyword: ${location.last_scan_status === 'completed' ? 'Active' : 'Pending'}]</span>` : ''}
      `;
    }

    const toggleBtn = card.querySelector('.btn-toggle');
    if (toggleBtn) {
      toggleBtn.dataset.enabled = location.enabled;
      toggleBtn.title = location.enabled ? 'Disable' : 'Enable' + ' scanning';
      toggleBtn.innerHTML = `<i class="fas ${location.enabled ? 'fa-pause' : 'fa-play'}"></i> ${location.enabled ? 'Disable' : 'Enable'}`;
    }
  }

  _createLocationElement(location) {
    const div = document.createElement('div');
    div.className = 'file-location-item';

    const statusClass = location.enabled ? 'enabled' : 'disabled';
    const statusText = location.enabled ? 'Enabled' : 'Disabled';
    const locationType = location.location_type || 'secondary';
    const typeIcon = locationType === 'primary' ? 'fa-star' : 'fa-folder';
    const typeLabel = locationType === 'primary' ? 'Primary' : 'Secondary';
    const lastScan = location.last_scan_at
      ? new Date(location.last_scan_at).toLocaleString()
      : 'Never';
    const indexSizeFormatted = this.formatBytes(location.index_size_bytes || 0);
    const activeReindexJobs = this.getActiveReindexJobs();

    div.innerHTML = `
      <div class="file-location-header">
        <div class="file-location-title">
          <i class="fas ${typeIcon}"></i>
          <span class="file-location-name">${this.escapeHtml(location.location_name)}</span>
          <span class="file-location-type-badge ${locationType}">${typeLabel}</span>
        </div>
        <div class="file-location-status ${statusClass}">
          ${statusText}
        </div>
      </div>
      
      <div class="file-location-path">${this.escapeHtml(location.root_path)}</div>
      
      <div class="inline-progress-container" data-location-id="${location.id}">
        ${this.renderInlineProgress(location.id)}
      </div>
      
      <div class="file-location-stats">
        <div class="file-location-stat">
          <div class="file-location-stat-label">Files</div>
          <div class="file-location-stat-value">${location.file_count || 0}</div>
        </div>
        <div class="file-location-stat">
          <div class="file-location-stat-label">Chunks</div>
          <div class="file-location-stat-value">${location.chunk_count || 0}</div>
        </div>
        <div class="file-location-stat">
          <div class="file-location-stat-label">Index Size</div>
          <div class="file-location-stat-value">${indexSizeFormatted}</div>
        </div>
        <div class="file-location-stat" style="flex: 2;">
          <div class="file-location-stat-label">Index Status</div>
          <div class="file-location-stat-value" style="display:flex; gap:4px; font-size:11px;">
            ${['semantic', 'combined'].includes(location.index_mode) ? `<span class="index-badge status-${location.last_scan_status === 'completed' ? 'active' : 'pending'}">[Smart Search: ${location.last_scan_status === 'completed' ? 'Active' : 'Pending'}]</span>` : ''}
            ${['bm25', 'combined'].includes(location.index_mode) ? `<span class="index-badge status-${location.last_scan_status === 'completed' ? 'active' : 'pending'}">[Keyword: ${location.last_scan_status === 'completed' ? 'Active' : 'Pending'}]</span>` : ''}
          </div>
        </div>
      </div>
      
      <div class="file-location-actions">
        <button class="file-location-btn btn-config" data-id="${location.id}" title="Configure indexing settings">
          <i class="fas fa-cog"></i> Config
        </button>
        <button class="file-location-btn btn-reindex" data-id="${location.id}" data-name="${this.escapeHtml(location.location_name)}" title="Reindex this location">
          <i class="fas fa-sync-alt"></i> Reindex
        </button>
        <button class="file-location-btn btn-toggle" data-id="${location.id}" data-enabled="${location.enabled}" title="${location.enabled ? 'Disable' : 'Enable'} scanning">
          <i class="fas ${location.enabled ? 'fa-pause' : 'fa-play'}"></i> ${location.enabled ? 'Disable' : 'Enable'}
        </button>
        <button class="file-location-btn danger btn-delete" data-id="${location.id}" data-name="${this.escapeHtml(location.location_name)}" title="Delete this location">
          <i class="fas fa-trash"></i> Delete
        </button>
      </div>
    `;

    // Track all listeners for cleanup
    const cardListeners = [];
    const configBtn = div.querySelector('.btn-config');
    const reindexBtn = div.querySelector('.btn-reindex');
    const toggleBtn = div.querySelector('.btn-toggle');
    const deleteBtn = div.querySelector('.btn-delete');

    const isJobActive = activeReindexJobs && activeReindexJobs[location.id];
    
    if (configBtn) {
      if (isJobActive) configBtn.disabled = true;
      const handler = () => this.showConfig(location);
      configBtn.addEventListener('click', handler);
      cardListeners.push({ element: configBtn, event: 'click', handler });
    }

    if (reindexBtn) {
      if (isJobActive) {
        reindexBtn.disabled = true;
        reindexBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Indexing...';
      }
      const handler = () => this.triggerReindex(location.id, location.location_name);
      reindexBtn.addEventListener('click', handler);
      cardListeners.push({ element: reindexBtn, event: 'click', handler });
    }

    const viewDetailsBtn = div.querySelector('.inline-view-details-btn');
    if (viewDetailsBtn) {
      const handler = () => {
        const jobId = viewDetailsBtn.getAttribute('data-job-id');
        const locationName = viewDetailsBtn.getAttribute('data-location-name');
        if (jobId) {
          this.showReindexProgress(locationName, jobId);
        }
      };
      viewDetailsBtn.addEventListener('click', handler);
      cardListeners.push({ element: viewDetailsBtn, event: 'click', handler });
    }

    if (toggleBtn) {
      const handler = () => this.toggleLocation(location.id, location.enabled);
      toggleBtn.addEventListener('click', handler);
      cardListeners.push({ element: toggleBtn, event: 'click', handler });
    }

    if (deleteBtn) {
      const handler = () => this.deleteLocation(location.id, location.location_name);
      deleteBtn.addEventListener('click', handler);
      cardListeners.push({ element: deleteBtn, event: 'click', handler });
    }

    this._locationCardListeners.set(location.id, cardListeners);
    return div;
  }

  _cleanupCardListeners(locationId) {
    const listeners = this._locationCardListeners.get(locationId);
    if (listeners) {
      for (const { element, event, handler } of listeners) {
        try {
          if (element) element.removeEventListener(event, handler);
        } catch (_) { /* element may already be removed */ }
      }
      this._locationCardListeners.delete(locationId);
    }
  }
}

module.exports = LocationCardRenderer;
