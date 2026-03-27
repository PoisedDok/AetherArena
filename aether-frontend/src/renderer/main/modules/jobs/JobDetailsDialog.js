/**
 * @.architecture
 * Incoming: JobHistoryModal, DialogManager --- {job object, open dialog request}
 * Processing: Render job details, timeline, results --- {JOB_RENDER_DETAILS, JOB_RENDER_RESULTS}
 * Outgoing: Dialog DOM element, job actions --- {formatted job info, cancel/retry requests}
 * 
 * JobDetailsDialog - Detailed Job View Overlay
 * 
 * Responsibilities:
 * - Render comprehensive job details in a professional overlay
 * - Show execution timeline and metadata
 * - Integrate mini-results viewer for completed jobs
 * - Provide action buttons (Cancel, Retry)
 */

'use strict';

const SourceResultDialog = require('./SourceResultDialog');

class JobDetailsDialog {
  /**
   * @param {Object} config - Dialog configuration
   * @param {Object} config.job - Job object to display
   * @param {Object} config.endpoint - API endpoint instance
   * @param {Object} config.logger - Logger instance
   * @param {Function} config.onAction - Callback for job actions (cancel, retry)
   */
  constructor(config = {}) {
    this.job = config.job;
    this.endpoint = config.endpoint;
    this.logger = config.logger || console;
    this.onAction = config.onAction || (() => {});
    
    // DOM reference
    this._dialogElement = null;
    
    if (!this.job) {
      throw new Error('JobDetailsDialog: Job object is required');
    }
  }

  /**
   * Create and return dialog DOM element
   * @returns {HTMLElement} Dialog element
   */
  create() {
    const agentLabel = this._formatAgentLabel(this.job.agent_name || this.job.agent || 'unknown');
    const status = String(this.job.status || 'unknown').toLowerCase();
    const id = this.job.id || this.job.job_id || '-';
    const type = this.job.type || 'job';
    
    const content = this.job.content || {};
    const results = this.job.results || this.job.metadata?.results || content.results;
    const timeMs = this.job.time_ms || content.time_ms || this.job.metadata?.time_ms;
    const modelUsed = this.job.model_used || content.model_used || this.job.metadata?.model_used;

    this._dialogElement = document.createElement('div');
    this._dialogElement.className = 'tool-dialog tool-dialog-wide';
    this._dialogElement.innerHTML = `
      <div class="tool-dialog-overlay"></div>
      <div class="tool-dialog-content job-details-dialog-v2">
        <div class="tool-dialog-header">
          <div class="header-title-group">
            <i class="fas fa-microchip"></i>
            <h3>${this._escapeHtml(agentLabel)}</h3>
          </div>
          <button class="tool-dialog-close" aria-label="Close">&times;</button>
        </div>
        
        <div class="tool-dialog-body">
          <!-- Horizontal Info Banner -->
          <div class="job-info-banner">
            <div class="info-banner-item status-item">
              <div class="job-status status-${status}">
                <i class="fas ${this._getStatusIcon(status)}"></i>
                ${status}
              </div>
            </div>
            
            <div class="info-banner-divider"></div>
            
            <div class="info-banner-item">
              <label>Job ID</label>
              <span class="mono-text" title="${id}">${this._formatShortId(id)}</span>
            </div>

            ${timeMs ? `
              <div class="info-banner-divider"></div>
              <div class="info-banner-item">
                <label>Duration</label>
                <span>${this._formatDuration(timeMs)}</span>
              </div>
            ` : ''}

            ${modelUsed ? `
              <div class="info-banner-divider"></div>
              <div class="info-banner-item">
                <label>Model</label>
                <span>${modelUsed}</span>
              </div>
            ` : ''}

            <div class="info-banner-divider"></div>
            
            <div class="info-banner-item actions-item">
              <div class="jobs-details-actions">
                ${this._renderJobActions(this.job)}
              </div>
            </div>
          </div>

          <div class="job-details-content-v2">
            <!-- Left: Timeline (Minimal Vertical) -->
            <div class="job-details-timeline-v2">
              <div class="details-label">Execution Timeline</div>
              <div class="timeline-track-v2">
                <div class="timeline-step is-complete">
                  <div class="timeline-dot"></div>
                  <div class="timeline-content">
                    <div class="timeline-stage">Created</div>
                    <div class="timeline-time">${this.job.created_at ? this._formatTimestamp(this.job.created_at) : '—'}</div>
                  </div>
                </div>
                ${type === 'job' && this.job.started_at ? `
                  <div class="timeline-step is-complete">
                    <div class="timeline-dot"></div>
                    <div class="timeline-content">
                      <div class="timeline-stage">Started</div>
                      <div class="timeline-time">${this._formatTimestamp(this.job.started_at)}</div>
                    </div>
                  </div>
                ` : ''}
                ${this.job.completed_at && this.job.completed_at !== this.job.created_at ? `
                  <div class="timeline-step is-complete">
                    <div class="timeline-dot"></div>
                    <div class="timeline-content">
                      <div class="timeline-stage">Completed</div>
                      <div class="timeline-time">${this._formatTimestamp(this.job.completed_at)}</div>
                    </div>
                  </div>
                ` : ''}
              </div>
            </div>

            <!-- Right: Results Grid -->
            <div class="job-details-results-v2">
              ${results ? `
                <div class="details-label">Agent Findings</div>
                <div class="results-grid-v2">
                  ${this._renderResultsGrid(results)}
                </div>
              ` : `
                <div class="jobs-details-empty-results">
                  <i class="fas ${status === 'completed' ? 'fa-info-circle' : 'fa-spinner fa-spin'}"></i>
                  <p>${status === 'completed' ? 'No detailed findings found in output.' : 'Awaiting results...'}</p>
                </div>
              `}
            </div>
          </div>
        </div>
      </div>
    `;

    return this._dialogElement;
  }

  _renderResultsGrid(results) {
    if (!results) return '';

    // Handle Research/Unified Search structure
    if (results.results && typeof results.results === 'object') {
      const sources = Array.isArray(results.sources_used)
        ? results.sources_used
        : Object.keys(results.results || {});

      if (sources.length > 0) {
        return sources.map((source) => {
          const block = results.results?.[source];
          if (!block) return '';

          let items = [];
          if (block && typeof block === 'object') {
            items = Array.isArray(block.results) ? block.results : (Array.isArray(block.items) ? block.items : (Array.isArray(block.sources) ? block.sources : []));
            if (items.length === 0 && Array.isArray(block)) {
              items = block;
            }
          }
          
          if (items.length === 0 && !(block.answer)) return '';
          
          return `
            <div class="result-card-v2" data-action="view-source-results" data-source="${this._escapeHtml(source)}">
              <div class="result-card-icon">
                <i class="fas ${this._getSourceIcon(source)}"></i>
              </div>
              <div class="result-card-content">
                <div class="result-card-source">${this._escapeHtml(source)}</div>
                <div class="result-card-stats">${items.length || (block.answer ? 1 : 0)} Findings</div>
              </div>
              <div class="result-card-arrow">
                <i class="fas fa-chevron-right"></i>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Generic fallback for any content that might be results
    return '<div class="no-results-box">Agent produced no detailed findings.</div>';
  }

  /**
   * Setup event listeners
   * @param {DialogManager} dialogManager - DialogManager instance
   */
  setupListeners(dialogManager) {
    if (!this._dialogElement) return;

    const closeBtn = this._dialogElement.querySelector('.tool-dialog-close');
    const overlay = this._dialogElement.querySelector('.tool-dialog-overlay');

    // Close handlers
    dialogManager.trackListener(closeBtn, 'click', () => dialogManager.close());
    dialogManager.trackListener(overlay, 'click', () => dialogManager.close());

    // Action buttons
    this._dialogElement.querySelectorAll('[data-action]').forEach(btn => {
      dialogManager.trackListener(btn, 'click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        e.stopImmediatePropagation();
        
        const action = btn.dataset.action;
        const jobId = btn.dataset.jobId;
        
        if (action === 'view-source-results') {
          const source = btn.dataset.source;
          this._openSourceDetailDialog(source, dialogManager);
          return;
        }

        if (action && jobId) {
          await this.onAction(action, jobId);
        }
      });
    });
  }

  _openSourceDetailDialog(source, dialogManager) {
    const content = this.job.content || {};
    const results = this.job.results || this.job.metadata?.results || content.results;
    
    if (!results || !results.results) return;
    
    const block = results.results[source];
    if (!block) return;

    const dialog = new SourceResultDialog({
      source: source,
      data: block,
      logger: this.logger
    });

    const dialogEl = dialog.create();
    dialogManager.open(dialogEl);
    dialog.setupListeners(dialogManager);
  }

  _getStatusIcon(status) {
    switch (status) {
      case 'completed': return 'fa-check-circle';
      case 'running':
      case 'processing': return 'fa-spinner fa-spin';
      case 'failed': return 'fa-exclamation-circle';
      case 'pending': return 'fa-clock';
      case 'cancelled': return 'fa-ban';
      default: return 'fa-question-circle';
    }
  }

  _renderJobActions(job) {
    const status = (job.status || '').toLowerCase();
    const id = job.id || job.job_id || '';
    
    // CONTRACT: Status-based text actions (No icons as requested)
    const isActive = ['pending', 'running', 'processing'].includes(status);
    const isFinished = ['completed', 'failed', 'cancelled'].includes(status);
    
    if (isActive) {
      return `
        <button class="job-item-action-btn-text cancel-btn" data-action="job-cancel" data-job-id="${id}" title="Cancel Job">
          CANCEL
        </button>
      `;
    }
    
    if (isFinished) {
      return `
        <button class="job-item-action-btn-text delete-btn" data-action="job-delete" data-job-id="${id}" title="Delete Job">
          DELETE
        </button>
      `;
    }

    return '';
  }

  _formatTimestamp(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (isNaN(date.getTime())) return String(value || '—');
    return date.toLocaleString();
  }

  _formatAgentLabel(value) {
    if (!value) return 'Unknown';
    return String(value)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  _formatShortId(id) {
    if (!id || id === '-') return '-';
    const s = String(id);
    if (s.length <= 12) return s;
    return s.substring(0, 8) + '...' + s.substring(s.length - 4);
  }

  _getSourceIcon(source) {
    const s = source.toLowerCase();
    if (s.includes('web')) return 'fa-globe';
    if (s.includes('news')) return 'fa-newspaper';
    if (s.includes('reddit')) return 'fa-reddit';
    if (s.includes('local')) return 'fa-folder-open';
    if (s.includes('file')) return 'fa-file-alt';
    return 'fa-database';
  }

  _formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const seconds = ms / 1000;
    if (seconds < 1) return `${ms}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m ${remainder}s`;
  }
}

// Global registration
if (typeof window !== 'undefined') {
  window.JobDetailsDialog = JobDetailsDialog;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = JobDetailsDialog;
}
