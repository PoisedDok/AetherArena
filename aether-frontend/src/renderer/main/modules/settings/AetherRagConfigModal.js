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

class AetherRagConfigModal {
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
            <h4>Chunking Configuration</h4>
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
          </div>
          
          <div class="indexing-config-section">
            <h4>File Extensions</h4>
            <div class="indexing-config-field">
              <label>
                Allowed Extensions
                <span class="indexing-config-hint">Comma-separated list (e.g., pdf, txt, md, docx)</span>
              </label>
              <input class="input" type="text" id="allowed-extensions" value="${allowedExtensions.join(', ')}" />
            </div>
          </div>
          
          <div class="indexing-config-section">
            <h4>Exclusion Patterns</h4>
            <div class="indexing-config-field">
              <label>
                Exclude Patterns
                <span class="indexing-config-hint">One pattern per line (glob syntax)</span>
              </label>
              <textarea class="textarea" id="exclude-patterns" rows="6">${excludePatterns.join('\n')}</textarea>
            </div>
          </div>
          
          <div class="indexing-config-note">
            <i class="fas fa-info-circle"></i>
            <span>Changes will trigger a reindex of this location</span>
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
      this.hide();
      this.onCancel();
    });
    
    // Save button
    this._trackListener(this.modal.querySelector('#indexing-config-save'), 'click', async () => {
      await this._handleSave();
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
        exclude_patterns: excludePatterns
      };
      
      // Disable save button
      const saveBtn = this.modal.querySelector('#indexing-config-save');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
      }
      
      // Call onSave callback
      await this.onSave(config);
      
      // Close modal
      this.hide();
      
    } catch (error) {
      this.logger.error('[IndexingConfigModal] Save failed:', error);
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
  module.exports = AetherRagConfigModal;
}

if (typeof window !== 'undefined') {
  window.AetherRagConfigModal = AetherRagConfigModal;
}
