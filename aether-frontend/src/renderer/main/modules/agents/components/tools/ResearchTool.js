/**
 * @.architecture
 * Incoming: AgentsModal, user actions --- {render request, invoke request, view results}
 * Processing: Render research card, create dialog, display status --- {JOB_RENDER_CARD, JOB_CREATE_DIALOG, JOB_STATUS}
 * Outgoing: HTML string, ResearchDialog instance --- {card HTML, dialog}
 * 
 * ResearchTool - Research Tool Component
 * 
 * Responsibilities:
 * - Render research tool card with status
 * - Create ResearchDialog for tool invocation
 * - Display research service status (Perplexica/Searxng)
 * - Show run state (running, completed, failed)
 * - Provide "View Results" and "Research History" actions
 * 
 * Extracted from AgentsModal.js lines 241-278, 380-408, 755-795
 */

'use strict';

const ToolComponent = require('./ToolComponent');
const ResearchDialog = require('../dialogs/ResearchDialog');
const Toast = require('../../../../../shared/components/Toast');

class ResearchTool extends ToolComponent {
  /**
   * @param {Object} config - Tool configuration
   * @param {Object} config.agent - Agent configuration object
   * @param {Object} config.endpoint - API endpoint instance
   * @param {Object} config.toolState - ToolStateManager instance
   * @param {Object} config.agentState - AgentStateManager instance
   * @param {Object} config.logger - Logger instance
   * @param {Object} config.templatesByName - Templates map (for description)
   */
  constructor(config = {}) {
    super({
      name: 'research',
      agent: config.agent,
      endpoint: config.endpoint,
      toolState: config.toolState,
      logger: config.logger
    });
    
    this.agentState = config.agentState;
    this.templatesByName = config.templatesByName || {};
  }

  /**
   * Render research tool card HTML
   * @returns {string} HTML string for tool card
   */
  render() {
    const agent = this.agent;
    const toolName = 'research';
    const displayName = this._formatAgentName(toolName);
    const description = this._getDescription();
    const isMissing = !agent;
    
    const status = this._renderServiceStatus();
    const runInfo = this._renderToolRunInfo();
    const latestRunState = this.toolState.getToolRunState(toolName);
    const hasResults = latestRunState?.results;

    const missingBadge = isMissing
      ? `<span class="tool-card-badge tool-card-badge--missing">Missing</span>`
      : '';

    const primaryAction = `
      <button class="btn-primary btn-sm tool-card-primary" type="button" data-action="tool-invoke" data-tool="research">
        <i class="fas fa-play"></i> Start Research
      </button>
    `;

    const secondaryActions = `
      <button class="btn-ghost btn-sm tool-card-secondary" type="button" data-action="open-research-history" data-tool="research">
        <i class="fas fa-history"></i> Research History
      </button>
      <button class="btn-ghost btn-sm tool-card-interface" type="button" data-action="open-perplexica-interface" data-tool="research" title="Open Perplexica research interface">
        <i class="fas fa-window-restore"></i> Agent Interface
      </button>
    `;

    return `
      <div class="tool-card ${isMissing ? 'is-disabled' : ''}" data-tool="${this._escapeHtml(toolName)}">
        <div class="tool-card-header">
          <div class="tool-card-title">
            <i class="fas fa-search"></i>
            <span>${this._escapeHtml(displayName)}</span>
            ${missingBadge}
          </div>
        </div>

        <div class="tool-card-body">
          <div class="tool-card-description">${this._escapeHtml(description)}</div>
          
          ${status ? `<div class="tool-card-status-section">${status}</div>` : ''}
          
          ${runInfo ? `<div class="tool-card-run-section">${runInfo}</div>` : ''}
          
          ${hasResults ? `
            <button class="btn-ghost btn-sm tool-card-view-results" type="button" data-action="view-results" data-tool="research">
              <i class="fas fa-eye"></i> View Results
            </button>
          ` : ''}
          
          <div class="tool-card-actions">
            ${primaryAction}
            ${secondaryActions}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Create ResearchDialog instance
   * @returns {ResearchDialog} Dialog instance
   */
  createDialog() {
    const researchStatus = this.toolState.getResearchStatus();
    
    if (!researchStatus) {
      throw new Error('Research status not available');
    }

    const models = this.agentState?.models || [];

    return new ResearchDialog({
      endpoint: this.endpoint,
      models: models,
      researchStatus: researchStatus,
      toolState: this.toolState,
      logger: this.logger
    });
  }

  /**
   * Get tool status object
   * @returns {Object} Status object
   */
  getStatus() {
    const researchStatus = this.toolState.getResearchStatus();
    return {
      available: Boolean(this.agent && researchStatus),
      researchStatus: researchStatus
    };
  }

  /**
   * Get tool description
   * @returns {string} Tool description
   */
  _getDescription() {
    const template = this.templatesByName?.['research'];
    if (template?.description) {
      return template.description;
    }
    return 'Research tool for legal workflow automation';
  }

  /**
   * Render research service status
   * @returns {string} HTML string for service status
   * @private
   */
  _renderServiceStatus() {
    const researchStatus = this.toolState.getResearchStatus();
    
    if (!researchStatus) {
      return `<div class="tool-card-statusline muted">Status unavailable.</div>`;
    }
    
    const aiEnabled = Boolean(researchStatus.perplexica_enabled);
    const fastEnabled = Boolean(researchStatus.searxng_enabled);
    const sources = researchStatus.available_sources || {};
    const aiSources = Array.isArray(sources.ai_mode) ? sources.ai_mode : [];
    const fastSources = Array.isArray(sources.fast_mode) ? sources.fast_mode : [];
    const localSources = Array.isArray(sources.local) ? sources.local : [];

    const chips = [
      aiEnabled ? `<span class="tool-chip ok">AI mode</span>` : `<span class="tool-chip warn">AI mode off</span>`,
      fastEnabled ? `<span class="tool-chip ok">Fast mode</span>` : `<span class="tool-chip warn">Fast mode off</span>`,
      localSources.length ? `<span class="tool-chip ok">Local</span>` : `<span class="tool-chip muted">Local</span>`
    ].join('');

    const sourcesSummary = [
      aiSources.length ? `AI: ${aiSources.join(', ')}` : null,
      fastSources.length ? `Fast: ${fastSources.join(', ')}` : null,
      localSources.length ? `Local: ${localSources.join(', ')}` : null
    ].filter(Boolean).join(' • ');

    return `
      <div class="tool-card-statusline">${chips}</div>
      <div class="tool-card-statusline muted">${this._escapeHtml(sourcesSummary || 'No sources reported')}</div>
    `;
  }

  /**
   * Render tool run info (current execution state)
   * @returns {string} HTML string for run info
   * @private
   */
  _renderToolRunInfo() {
    const state = this.toolState.getToolRunState('research');
    if (!state) return '';
    
    const status = state.status ? String(state.status).toLowerCase() : 'unknown';
    const isRunning = status === 'running' || status === 'processing';
    const duration = Number.isFinite(state.time_ms) ? this._formatDuration(state.time_ms) : '';
    const sourceCount = Number.isFinite(state.sources_used) ? state.sources_used : 0;
    
    if (isRunning) {
      return `
        <div class="tool-run-status status-running">
          <span class="tool-status-spinner"></span>
          <span>Running job...</span>
        </div>
      `;
    }
    
    if (status === 'completed') {
      return `
        <div class="tool-run-status status-completed">
          <i class="fas fa-check-circle"></i>
          <span>Completed ${duration ? `in ${duration}` : ''}</span>
          ${sourceCount > 0 ? `<span class="tool-run-badge">${sourceCount} source${sourceCount !== 1 ? 's' : ''}</span>` : ''}
        </div>
      `;
    }
    
    if (status === 'failed') {
      return `
        <div class="tool-run-status status-failed">
          <i class="fas fa-exclamation-circle"></i>
          <span>Failed</span>
        </div>
      `;
    }
    
    return '';
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ResearchTool;
}

// Global registration
if (typeof window !== 'undefined') {
  window.ResearchTool = ResearchTool;
}
