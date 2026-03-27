/**
 * @.architecture
 * Incoming: FileIndexingManager, Aether dialog --- {user click, directory paths}
 * Processing: display native directory picker, show selected path and file count, validate selection --- {3 jobs: JOB_RENDER_UI, JOB_VALIDATE, JOB_EMIT_EVENT}
 * Outgoing: FileIndexingManager --- {selected path, location type, file count}
 */

/**
 * Get Aether bridge (browser context - no require available)
 * This file is loaded as a script tag in HTML, not bundled
 */
function getAether() {
  return typeof window !== 'undefined' ? window.aether : null;
}

class LocationSelectorModal {
  constructor(options = {}) {
    this.onSelect = options.onSelect || (() => {});
    this.onCancel = options.onCancel || (() => {});
    this.aether = options.aether || getAether();
    this.logger = this.aether?.logger || console;
    this.selectedPath = null;
    this.selectedType = 'secondary';
    this.fileCount = 0;
    this.modal = null;
    this.isProcessing = false;
    this._listeners = [];
  }

  /**
   * Show the location selector modal
   */
  async show() {
    this._createModal();
    document.body.appendChild(this.modal);
    
    // Animate in (modal-base expects .is-visible)
    requestAnimationFrame(() => {
      this.modal.classList.add('is-visible');
    });
  }

  /**
   * Create modal DOM structure
   */
  _createModal() {
    this.modal = document.createElement('div');
    this.modal.className = 'modal-overlay location-selector-modal';
    this.modal.innerHTML = `
      <div class="modal-panel location-selector-panel" role="dialog" aria-modal="true" aria-label="Select Indexing Location">
        <div class="modal-header">
          <h3 class="modal-title">Select Indexing Location</h3>
          <button class="modal-close location-selector-close" aria-label="Close">&times;</button>
        </div>

        <div class="modal-body location-selector-body">
          <div class="location-type-selector">
            <label class="location-type-option">
              <input type="radio" name="locationType" value="primary" />
              <span class="location-type-label">
                <i class="fas fa-star"></i>
                <strong>Primary Location</strong>
                <small>Indexed first, higher priority</small>
              </span>
            </label>
            <label class="location-type-option">
              <input type="radio" name="locationType" value="secondary" checked />
              <span class="location-type-label">
                <i class="fas fa-folder"></i>
                <strong>Secondary Location</strong>
                <small>Indexed after primary locations</small>
              </span>
            </label>
          </div>

          <div class="location-selector-main">
            <div class="location-picker-section">
              <button class="btn-primary location-picker-btn" id="location-picker-btn">
                <i class="fas fa-folder-open"></i> Choose Directory
              </button>
            </div>

            <div class="location-selected-info" id="location-selected-info" hidden>
              <div class="location-selected-path">
                <i class="fas fa-folder"></i>
                <span id="location-selected-path-text"></span>
              </div>
            </div>
            
            <div class="location-mode-selector" style="margin-top: 16px;">
              <h4>Search Capabilities</h4>
              <div style="display:flex; gap:16px; margin-top: 8px;">
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                  <input type="radio" name="indexMode" value="combined" checked />
                  <span>Hybrid</span>
                </label>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                  <input type="radio" name="indexMode" value="semantic" />
                  <span>Smart Search</span>
                </label>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                  <input type="radio" name="indexMode" value="bm25" />
                  <span>Keyword Search</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" id="location-selector-cancel">Cancel</button>
          <button class="btn-primary" id="location-selector-confirm" disabled>Confirm</button>
        </div>
      </div>
    `;
    
    this._attachEventListeners();
  }

  _trackListener(target, eventName, handler, options) {
    target.addEventListener(eventName, handler, options);
    this._listeners.push({ target, eventName, handler, options });
  }

  _cleanupListeners() {
    for (const { target, eventName, handler, options } of this._listeners) {
      try {
        target?.removeEventListener(eventName, handler, options);
      } catch {
        // ignore
      }
    }
    this._listeners = [];
  }

  /**
   * Attach event listeners
   */
  _attachEventListeners() {
    // Click outside panel (overlay)
    this._trackListener(this.modal, 'click', (e) => {
      if (e.target === this.modal) {
        this.hide();
        this.onCancel();
      }
    });

    // Escape closes
    this._trackListener(window, 'keydown', (e) => {
      if (e.key === 'Escape') {
        this.hide();
        this.onCancel();
      }
    });

    // Close button
    this._trackListener(this.modal.querySelector('.location-selector-close'), 'click', () => {
      this.hide();
      this.onCancel();
    });
    
    // Location type selection
    this.modal.querySelectorAll('input[name="locationType"]').forEach(radio => {
      this._trackListener(radio, 'change', (e) => {
        this.selectedType = e.target.value;
      });
    });
    
    // Native picker button
    const pickerBtn = this.modal.querySelector('#location-picker-btn');
    if (pickerBtn) {
      this._trackListener(pickerBtn, 'click', async () => {
        await this._openNativePicker();
      });
    }
    
    // Confirm/Cancel
    this._trackListener(this.modal.querySelector('#location-selector-cancel'), 'click', () => {
      this.hide();
      this.onCancel();
    });
    
    this._trackListener(this.modal.querySelector('#location-selector-confirm'), 'click', async () => {
      if (this.selectedPath && !this.isProcessing) {
        await this._handleConfirm();
      }
    });
  }

  /**
   * Open native directory picker
   */
  async _openNativePicker() {
    try {
      if (!this.aether?.dialog?.showDirectoryPicker) {
        this._showError('Directory picker not available');
        return;
      }
      
      const directory = await this.aether.dialog.showDirectoryPicker();
      if (directory) {
        this.selectedPath = directory;
        await this._updateSelectedInfo();
      }
    } catch (error) {
      this.logger.error('[LocationSelector] Native picker failed:', error);
      if (error.message && !error.message.includes('canceled')) {
        this._showError('Failed to select directory');
      }
    }
  }

  /**
   * Update selected location info
   */
  async _updateSelectedInfo() {
    const pathEl = this.modal.querySelector('#location-selected-path-text');
    const infoSection = this.modal.querySelector('#location-selected-info');
    const confirmBtn = this.modal.querySelector('#location-selector-confirm');
    
    if (!pathEl || !infoSection || !confirmBtn) return;
    
    // Show selected path
    pathEl.textContent = this.selectedPath;
    infoSection.hidden = false;
    
    // Enable confirm button
    confirmBtn.disabled = false;
  }

  /**
   * Handle confirm button click
   */
  async _handleConfirm() {
    if (!this.selectedPath) return;
    
    this.isProcessing = true;
    const confirmBtn = this.modal.querySelector('#location-selector-confirm');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    }
    
    try {
      const modeRadios = this.modal.querySelectorAll('input[name="indexMode"]');
      let indexMode = 'combined';
      modeRadios.forEach(r => { if(r.checked) indexMode = r.value; });

      // Call onSelect callback
      await this.onSelect({
        path: this.selectedPath,
        type: this.selectedType,
        indexMode: indexMode,
        fileCount: this.fileCount
      });
      
      // Show success feedback
      this._showSuccess('Location added successfully!');
      
      // Auto-close after short delay
      setTimeout(() => {
        this.hide();
      }, 800);
      
    } catch (error) {
      this.logger.error('[LocationSelector] Confirm failed:', error);
      this._showError(error.message || 'Failed to add location');
      
      // Re-enable confirm button
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = 'Confirm';
      }
      this.isProcessing = false;
    }
  }

  /**
   * Show success message
   */
  _showSuccess(message) {
    const successEl = document.createElement('div');
    successEl.className = 'location-selector-feedback success';
    successEl.innerHTML = `<i class="fas fa-check-circle"></i> ${message}`;
    this.modal.querySelector('.location-selector-body').appendChild(successEl);
    
    setTimeout(() => {
      successEl.remove();
    }, 3000);
  }

  /**
   * Show error message
   */
  _showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'location-selector-feedback error';
    errorEl.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${message}`;
    this.modal.querySelector('.location-selector-body').appendChild(errorEl);
    
    setTimeout(() => {
      errorEl.remove();
    }, 4000);
  }

  /**
   * Get home directory (safe for renderer process)
   */
  _getHomeDirectory() {
    return '/';
  }

  /**
   * Hide modal
   */
  hide() {
    if (this.modal) {
      this.modal.classList.remove('is-visible');
      this._cleanupListeners();
      setTimeout(() => {
        if (this.modal && this.modal.parentNode) {
          this.modal.parentNode.removeChild(this.modal);
        }
        this.modal = null;
      }, 200);
    }
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LocationSelectorModal;
}

if (typeof window !== 'undefined') {
  window.LocationSelectorModal = LocationSelectorModal;
}
