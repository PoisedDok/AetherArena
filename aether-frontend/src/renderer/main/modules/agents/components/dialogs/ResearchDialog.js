/**
 * @.architecture
 * Incoming: ResearchTool, DialogManager, user input --- {open dialog, form submission}
 * Processing: Render research form, validate inputs, submit to API --- {JOB_RENDER_FORM, JOB_VALIDATE, JOB_SUBMIT}
 * Outgoing: Backend API /v1/research, Toast notifications --- {research invocation, results}
 * 
 * ResearchDialog - Research Tool Invocation Dialog
 * 
 * Responsibilities:
 * - Render research form with all parameters
 * - Handle source selection and availability
 * - Validate user inputs
 * - Submit research request to backend
 * - Update tool state with results
 * 
 * Extracted from AgentsModal.js lines 1737-1845, 2033-2145
 */

'use strict';

const Toast = require('../../../../../shared/components/Toast');

class ResearchDialog {
  /**
   * @param {Object} config - Dialog configuration
   * @param {Object} config.endpoint - API endpoint instance
   * @param {Array} config.models - Available models
   * @param {Object} config.researchStatus - Research service status
   * @param {Object} config.toolState - ToolStateManager instance
   * @param {Object} config.logger - Logger instance
   */
  constructor(config = {}) {
    this.endpoint = config.endpoint;
    this.models = config.models || [];
    this.researchStatus = config.researchStatus;
    this.toolState = config.toolState;
    this.logger = config.logger || console;
    
    // DOM reference
    this._dialogElement = null;
    
    if (!this.endpoint) {
      throw new Error('ResearchDialog: Endpoint is required');
    }
    
    if (!this.researchStatus) {
      throw new Error('ResearchDialog: Research status is required');
    }
    
    if (!this.toolState) {
      throw new Error('ResearchDialog: ToolStateManager is required');
    }
  }

  /**
   * Create and return dialog DOM element
   * @returns {HTMLElement} Dialog element
   */
  create() {
    // Validate research status structure
    if (!this.researchStatus?.available_sources?.ai_mode || 
        !this.researchStatus?.available_sources?.fast_mode) {
      throw new Error('Research status missing available_sources');
    }

    const modelOptions = [
      '<option value="">Use agent/default model</option>',
      ...this.models.map(model => `<option value="${model.name}">${this._escapeHtml(model.name)}</option>`)
    ].join('');

    const sources = this._buildSourceOptions(this.researchStatus.available_sources);

    this._dialogElement = document.createElement('div');
    this._dialogElement.className = 'tool-dialog';
    this._dialogElement.innerHTML = `
      <div class="tool-dialog-overlay"></div>
      <div class="tool-dialog-content">
        <div class="tool-dialog-header">
          <h3><i class="fas fa-search"></i> Research Tool</h3>
          <button class="tool-dialog-close" aria-label="Close">&times;</button>
        </div>
        <div class="tool-dialog-body">
          <div class="tool-dialog-section">
            <label>Query</label>
            <textarea class="tool-research-query" rows="5" placeholder="Enter research question"></textarea>
          </div>
          <div class="tool-dialog-section">
            <label>Mode</label>
            <select class="tool-research-ai-mode">
              <option value="">Use backend default</option>
              <option value="ai">AI mode (Perplexica)</option>
              <option value="fast">Fast mode (Searxng)</option>
            </select>
          </div>
          <div class="tool-dialog-section">
            <label>Optimization Mode</label>
            <select class="tool-research-optimization">
              <option value="">Use backend default</option>
              <option value="speed">Speed (2 iterations, fast)</option>
              <option value="balanced">Balanced (6 iterations, thorough)</option>
              <option value="quality">Quality (25 iterations, comprehensive)</option>
            </select>
          </div>
          <div class="tool-dialog-section">
            <label>Sources</label>
            <div class="tool-sources-list">
              ${sources}
            </div>
          </div>
          <div class="tool-dialog-section">
            <label>Max Results Per Source</label>
            <input type="number" class="tool-research-max-results" min="1" max="20" placeholder="Use backend default" />
          </div>
          <div class="tool-dialog-section">
            <label>Model Override</label>
            <select class="tool-research-model">
              ${modelOptions}
            </select>
          </div>
          <div class="tool-dialog-status tool-dialog-status--hidden"></div>
          <div class="tool-dialog-results tool-dialog-results--hidden"></div>
        </div>
        <div class="tool-dialog-footer">
          <button class="btn-secondary tool-dialog-cancel">Cancel</button>
          <button class="btn-primary tool-dialog-submit">Start Research</button>
        </div>
      </div>
    `;

    return this._dialogElement;
  }

  /**
   * Setup event listeners (called by DialogManager after adding to DOM)
   * @param {DialogManager} dialogManager - DialogManager instance
   * @param {Function} onRefresh - Callback to refresh hub UI
   */
  setupListeners(dialogManager, onRefresh) {
    if (!this._dialogElement) {
      this.logger.error('ResearchDialog: Cannot setup listeners, dialog not created');
      return;
    }

    const closeBtn = this._dialogElement.querySelector('.tool-dialog-close');
    const cancelBtn = this._dialogElement.querySelector('.tool-dialog-cancel');
    const overlay = this._dialogElement.querySelector('.tool-dialog-overlay');
    const submitBtn = this._dialogElement.querySelector('.tool-dialog-submit');
    const aiModeSelect = this._dialogElement.querySelector('.tool-research-ai-mode');

    // Close handlers
    dialogManager.trackListener(closeBtn, 'click', () => dialogManager.close());
    dialogManager.trackListener(cancelBtn, 'click', () => dialogManager.close());
    dialogManager.trackListener(overlay, 'click', () => dialogManager.close());

    // AI mode change handler (updates source availability)
    dialogManager.trackListener(aiModeSelect, 'change', () => {
      this._updateSourceAvailability(aiModeSelect.value);
    });
    
    // Initial source availability update
    this._updateSourceAvailability(aiModeSelect.value);
    
    // Make source items clickable (CSS handles active state via :has(input:checked))
    const sourceItems = this._dialogElement.querySelectorAll('.aether-toggle');
    sourceItems.forEach(item => {
      // No manual listener needed for checkbox toggling when using <label>
      
      // Initial active state (if needed for older browsers, but :has() is preferred)
      const checkbox = item.querySelector('input[type="checkbox"]');
      if (checkbox && checkbox.checked) {
        item.classList.add('is-active');
      }
      
      // Still need listener to toggle is-active class if we don't rely solely on :has()
      dialogManager.trackListener(checkbox, 'change', () => {
        if (checkbox.checked) {
          item.classList.add('is-active');
        } else {
          item.classList.remove('is-active');
        }
      });
    });

    // Submit handler
    dialogManager.trackListener(submitBtn, 'click', async () => {
      try {
        await this._submit(dialogManager, onRefresh);
      } catch (error) {
        this.logger.error('ResearchDialog: Invocation failed:', error);
      }
    });
  }

  /**
   * Build source options HTML
   * @param {Object} availableSources - Available sources by mode
   * @returns {string} HTML string
   * @private
   */
  _buildSourceOptions(availableSources) {
    const aiSources = Array.isArray(availableSources.ai_mode) ? availableSources.ai_mode : [];
    const fastSources = Array.isArray(availableSources.fast_mode) ? availableSources.fast_mode : [];
    const localSources = Array.isArray(availableSources.local) ? availableSources.local : [];
    const allSources = Array.from(new Set([...aiSources, ...fastSources, ...localSources]));

    return allSources.map((source) => {
      const modes = [];
      if (aiSources.includes(source)) modes.push('ai');
      if (fastSources.includes(source)) modes.push('fast');
      if (localSources.includes(source)) modes.push('local');
      const modeAttr = modes.join(',');
      
      return `
        <label class="aether-toggle" data-modes="${modeAttr}">
          <input type="checkbox" value="${this._escapeHtml(source)}" checked />
          <span class="toggle-label">${this._escapeHtml(source)}</span>
        </label>
      `;
    }).join('');
  }

  /**
   * Update source availability based on selected mode
   * @param {string} mode - Selected mode (ai|fast|'')
   * @private
   */
  _updateSourceAvailability(mode) {
    if (!this._dialogElement) return;
    
    const items = this._dialogElement.querySelectorAll('.aether-toggle');
    items.forEach((item) => {
      const modes = (item.dataset.modes || '').split(',').filter(Boolean);
      const checkbox = item.querySelector('input');
      
      if (!mode) {
        // No mode selected = all sources available
        checkbox.disabled = false;
        item.classList.remove('is-disabled');
        return;
      }
      
      // Check if source is available in selected mode
      const allowed = mode === 'ai'
        ? modes.includes('ai') || modes.includes('local')
        : modes.includes('fast') || modes.includes('local');
      
      checkbox.disabled = !allowed;
      if (!allowed) {
        checkbox.checked = false;
        item.classList.add('is-disabled');
      } else {
        item.classList.remove('is-disabled');
      }
    });
  }

  /**
   * Submit research request
   * @param {DialogManager} dialogManager - DialogManager instance
   * @param {Function} onRefresh - Callback to refresh hub UI
   * @private
   */
  async _submit(dialogManager, onRefresh) {
    if (!this._dialogElement || !this.endpoint) return;

    // Gather form inputs
    const queryInput = this._dialogElement.querySelector('.tool-research-query');
    const aiModeSelect = this._dialogElement.querySelector('.tool-research-ai-mode');
    const optimizationSelect = this._dialogElement.querySelector('.tool-research-optimization');
    const maxResultsInput = this._dialogElement.querySelector('.tool-research-max-results');
    const modelSelect = this._dialogElement.querySelector('.tool-research-model');

    // Validate query
    const query = queryInput?.value?.trim();
    if (!query) {
      Toast.error('Query is required');
      return;
    }

    // Build payload
    const payload = { query };
    
    if (aiModeSelect?.value === 'ai') payload.ai_mode = true;
    if (aiModeSelect?.value === 'fast') payload.ai_mode = false;
    if (optimizationSelect?.value) payload.optimization_mode = optimizationSelect.value;

    // Collect selected sources
    const sources = Array.from(this._dialogElement.querySelectorAll('.aether-toggle input'))
      .filter((input) => input.checked)
      .map((input) => input.value);
    if (sources.length) payload.sources = sources;

    const maxResults = parseInt(maxResultsInput?.value, 10);
    if (Number.isFinite(maxResults)) payload.max_results = maxResults;
    if (modelSelect?.value) payload.model = modelSelect.value;
    
    // CRITICAL: Mark this as manual UI invocation to persist to job history
    payload.persist_history = true;

    // Close dialog immediately
    dialogManager.close();
    
    // Mark as running on card with query for UI visibility
    this.toolState.recordToolRun('research', {
      status: 'running',
      query: query,
      timestamp: new Date().toISOString()
    });
    
    // Refresh UI to show running state
    if (onRefresh) onRefresh(true);

    try {
      const startedAt = Date.now();
      
      // Run research (synchronous, returns results + output_id for persistence)
      const response = await this.endpoint.runResearch(payload);
      
      const elapsed = response?.time_ms ?? (Date.now() - startedAt);
      const sourcesUsed = Array.isArray(response?.sources_used) ? response.sources_used : [];
      
      // Record success (includes output_id for traceability)
      this.toolState.recordToolRun('research', {
        status: 'completed',
        time_ms: elapsed,
        sources_used: sourcesUsed.length || 0,
        results: response,
        output_id: response?.output_id,
        entity_id: response?.entity_id
      });
      
      Toast.success(`Research completed in ${this._formatDuration(elapsed)} • Saved to history`);
      
      // Refresh UI to show completed state
      if (onRefresh) onRefresh();
      
    } catch (error) {
      this.toolState.recordToolRun('research', { status: 'failed' });
      this.logger.error('ResearchDialog: Research failed:', error);
      Toast.error(`Research failed: ${error.message || 'Unknown error'}`);
      
      // Refresh UI to show failed state
      if (onRefresh) onRefresh();
    }
  }

  /**
   * Format duration in milliseconds
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration
   * @private
   */
  _formatDuration(ms) {
    const seconds = ms / 1000;
    if (seconds < 1) return `${ms}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m ${remainder}s`;
  }

  /**
   * Escape HTML for safe rendering
   * @param {string} text - Text to escape
   * @returns {string} Escaped HTML
   * @private
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this._dialogElement = null;
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ResearchDialog;
}

// Global registration
if (typeof window !== 'undefined') {
  window.ResearchDialog = ResearchDialog;
}
