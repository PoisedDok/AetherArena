/**
 * @.architecture
 * Incoming: FileIndexingManager, location config --- {user click, current settings}
 * Processing: display indexing configuration form, validate inputs, update settings --- {3 jobs: JOB_RENDER_UI, JOB_VALIDATE, JOB_EMIT_EVENT}
 * Outgoing: FileIndexingManager --- {updated config}
 */

/**
 * Get Aether bridge (browser context - no require available)
 * This file is loaded as a script tag in HTML, not bundled
 */
function getAether() {
  return typeof window !== 'undefined' ? window.aether : null;
}

class IndexingConfigModal {
  constructor(options = {}) {
    this.onSave = options.onSave || (() => {});
    this.onCancel = options.onCancel || (() => {});
    this.aether = options.aether || getAether();
    this.logger = this.aether?.logger || console;
    this.location = options.location || {};
    this.modal = null;
    this._listeners = [];
  }

  /**
   * Show the configuration modal
   */
  async show() {
    this._createModal();
    document.body.appendChild(this.modal);
    
    // Animate in
    requestAnimationFrame(() => {
      this.modal.classList.add('is-visible');
    });
  }

  /**
   * Create modal DOM structure
   */
  _createModal() {
    this.modal = document.createElement('div');
    this.modal.className = 'modal-overlay indexing-config-modal';
    
    const chunkSize = this.location.chunk_size || 512;
    const chunkOverlap = this.location.chunk_overlap || 50;
    const allowedExtensions = this.location.allowed_extensions || ['pdf', 'txt', 'md', 'docx'];
    const excludePatterns = this.location.exclude_patterns || ['**/.git/**', '**/node_modules/**'];
    
    this.modal.innerHTML = `
      <div class="modal-panel indexing-config-panel" role="dialog" aria-modal="true" aria-label="Indexing Configuration">
        <div class="modal-header">
          <h3 class="modal-title"><i class="fas fa-cog"></i> Indexing Configuration</h3>
          <button class="modal-close indexing-config-close" aria-label="Close">&times;</button>
        </div>

        <div class="modal-body indexing-config-body">
          <div class="indexing-config-section">
            <h4>Location</h4>
            <div class="indexing-config-field disabled">
              <label>Name</label>
              <input class="input" type="text" value="${this._escapeHtml(this.location.location_name || '')}" disabled />
            </div>
            <div class="indexing-config-field disabled">
              <label>Path</label>
              <input class="input" type="text" value="${this._escapeHtml(this.location.root_path || '')}" disabled />
            </div>
          </div>
          
          <div class="indexing-config-section">
            <h4>Indexing Options</h4>
            <div class="indexing-config-field">
              <label>Search Capabilities</label>
              <div class="search-mode-toggles" style="display:flex; gap:10px; margin-top:8px;">
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                  <input type="checkbox" id="mode-semantic" ${['semantic', 'combined'].includes(this.location.index_mode || 'combined') ? 'checked' : ''}>
                  <span>Smart Search</span>
                </label>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                  <input type="checkbox" id="mode-bm25" ${['bm25', 'combined'].includes(this.location.index_mode || 'combined') ? 'checked' : ''}>
                  <span>Keyword Search</span>
                </label>
              </div>
              <span class="indexing-config-hint" style="margin-top:4px; display:block;">Select at least one mode. Changing modes will trigger a full reindex.</span>
            </div>
            
            <div class="indexing-config-field" style="margin-top:16px;">
              <label>Processing Speed vs Quality</label>
              <select class="input" id="processing-preset" style="width:100%; margin-top:8px;">
                <option value="balanced" selected>Balanced (Recommended)</option>
                <option value="fast">Fast (Larger chunks, faster indexing)</option>
                <option value="quality">High Quality (Smaller chunks, slower indexing)</option>
              </select>
            </div>
          </div>
          
          <div class="indexing-config-section advanced-settings-section">
            <h4 class="advanced-settings-toggle" style="cursor:pointer; color:var(--text-secondary); display:flex; align-items:center; gap:8px; user-select:none;">
              <i class="fas fa-chevron-right" style="font-size:0.8em; transition: transform 0.2s;"></i>
              Advanced Settings
            </h4>
            <div class="advanced-settings-content" style="display:none; margin-top:16px; padding-left:16px; border-left:2px solid var(--border-color);">
              
              <div class="indexing-config-field">
                <label>
                  Chunk Size
                  <span class="indexing-config-hint">Number of characters per chunk (128-2048)</span>
                </label>
                <input class="input" type="number" id="chunk-size" value="${chunkSize}" min="128" max="2048" step="64" />
              </div>
              
              <div class="indexing-config-field">
                <label>
                  Chunk Overlap
                  <span class="indexing-config-hint">Characters of overlap between chunks (0-512)</span>
                </label>
                <input class="input" type="number" id="chunk-overlap" value="${chunkOverlap}" min="0" max="512" step="10" />
              </div>
              
              <div class="indexing-config-field" style="margin-top:16px;">
                <label>
                  Allowed Extensions
                  <span class="indexing-config-hint">Comma-separated list (e.g., pdf, txt, md, docx)</span>
                </label>
                <input class="input" type="text" id="allowed-extensions" value="${allowedExtensions.join(', ')}" />
              </div>
              
              <div class="indexing-config-field" style="margin-top:16px;">
                <label>
                  Exclude Patterns
                  <span class="indexing-config-hint">One pattern per line (glob syntax)</span>
                </label>
                <textarea class="textarea" id="exclude-patterns" rows="4">${excludePatterns.join('\n')}</textarea>
              </div>
              
            </div>
          </div>
          
          <div class="indexing-config-note" style="margin-top:24px;">
            <i class="fas fa-info-circle"></i>
            <span>Changes will trigger a full reindex of this location</span>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" id="indexing-config-cancel">Cancel</button>
          <button class="btn-primary" id="indexing-config-save">
            <i class="fas fa-save"></i> Save & Reindex
          </button>
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
    this._trackListener(this.modal.querySelector('.indexing-config-close'), 'click', () => {
      this.hide();
      this.onCancel();
    });
    
    // Cancel button
    this._trackListener(this.modal.querySelector('#indexing-config-cancel'), 'click', () => {
      if (this.abortController) {
        this.logger.debug('[AetherRagConfigModal] Cancelling active save operation...');
        this.abortController.abort();
        this.abortController = null;
      }
      this.hide();
      this.onCancel();
    });
    
    // Save button
    this._trackListener(this.modal.querySelector('#indexing-config-save'), 'click', async () => {
      await this._handleSave();
    });

    // Advanced Settings Accordion
    const advancedToggle = this.modal.querySelector('.advanced-settings-toggle');
    const advancedContent = this.modal.querySelector('.advanced-settings-content');
    const chevronIcon = advancedToggle.querySelector('i');
    
    this._trackListener(advancedToggle, 'click', () => {
      const isHidden = advancedContent.style.display === 'none';
      if (isHidden) {
        advancedContent.style.display = 'block';
        chevronIcon.style.transform = 'rotate(90deg)';
      } else {
        advancedContent.style.display = 'none';
        chevronIcon.style.transform = 'rotate(0deg)';
      }
    });

    // Preset dropdown logic
    const presetSelect = this.modal.querySelector('#processing-preset');
    const chunkSizeInput = this.modal.querySelector('#chunk-size');
    const chunkOverlapInput = this.modal.querySelector('#chunk-overlap');
    
    // Auto-detect preset on load
    const currentSize = parseInt(chunkSizeInput.value, 10);
    if (currentSize <= 256) presetSelect.value = 'quality';
    else if (currentSize >= 1024) presetSelect.value = 'fast';
    else presetSelect.value = 'balanced';

    this._trackListener(presetSelect, 'change', (e) => {
      const preset = e.target.value;
      if (preset === 'fast') {
        chunkSizeInput.value = 1024;
        chunkOverlapInput.value = 100;
      } else if (preset === 'quality') {
        chunkSizeInput.value = 256;
        chunkOverlapInput.value = 25;
      } else {
        // balanced
        chunkSizeInput.value = 512;
        chunkOverlapInput.value = 50;
      }
    });
  }

  /**
   * Handle save button click
   */
  async _handleSave() {
    try {
      // Collect values
      const chunkSize = parseInt(this.modal.querySelector('#chunk-size').value, 10);
      const chunkOverlap = parseInt(this.modal.querySelector('#chunk-overlap').value, 10);
      const allowedExtensionsStr = this.modal.querySelector('#allowed-extensions').value;
      const excludePatternsStr = this.modal.querySelector('#exclude-patterns').value;
      
      const semanticChecked = this.modal.querySelector('#mode-semantic').checked;
      const bm25Checked = this.modal.querySelector('#mode-bm25').checked;
      
      let indexMode = 'semantic';
      if (semanticChecked && bm25Checked) {
        indexMode = 'combined';
      } else if (bm25Checked) {
        indexMode = 'bm25';
      } else if (semanticChecked) {
        indexMode = 'semantic';
      } else {
        this._showError('You must select at least one search capability');
        return;
      }
      
      // Validate
      if (chunkSize < 128 || chunkSize > 2048) {
        this._showError('Chunk size must be between 128 and 2048');
        return;
      }
      
      if (chunkOverlap < 0 || chunkOverlap > 512) {
        this._showError('Chunk overlap must be between 0 and 512');
        return;
      }
      
      if (chunkOverlap >= chunkSize) {
        this._showError('Chunk overlap must be less than chunk size');
        return;
      }
      
      // Parse arrays
      const allowedExtensions = allowedExtensionsStr
        .split(',')
        .map(ext => ext.trim())
        .filter(ext => ext.length > 0);
      
      const excludePatterns = excludePatternsStr
        .split('\n')
        .map(pattern => pattern.trim())
        .filter(pattern => pattern.length > 0);
      
      if (allowedExtensions.length === 0) {
        this._showError('At least one file extension is required');
        return;
      }
      
      // Create config object
      const config = {
        chunk_size: chunkSize,
        chunk_overlap: chunkOverlap,
        allowed_extensions: allowedExtensions,
        exclude_patterns: excludePatterns,
        index_mode: indexMode
      };
      
      // Disable save button
      const saveBtn = this.modal.querySelector('#indexing-config-save');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
      }
      
      this.abortController = new AbortController();
      
      // Call onSave callback with abort signal
      await this.onSave(config, this.abortController.signal);
      this.abortController = null;
      
      // Close modal
      this.hide();
      
    } catch (error) {
      if (error.name === 'AbortError') {
        this.logger.debug('[AetherRagConfigModal] Save aborted by user');
        this.abortController = null;
        this.hide();
        return;
      }
      this.logger.error('[AetherRagConfigModal] Save failed:', error);
      this._showError(error.message || 'Failed to save configuration');
      
      // Re-enable save button
      const saveBtn = this.modal.querySelector('#indexing-config-save');
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save & Reindex';
      }
    }
  }

  /**
   * Show error message
   */
  _showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'indexing-config-error';
    errorEl.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${message}`;
    
    const body = this.modal.querySelector('.indexing-config-body');
    body.insertBefore(errorEl, body.firstChild);
    
    setTimeout(() => {
      errorEl.remove();
    }, 4000);
  }

  /**
   * Escape HTML
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
  module.exports = IndexingConfigModal;
}

if (typeof window !== 'undefined') {
  window.IndexingConfigModal = IndexingConfigModal;
}
