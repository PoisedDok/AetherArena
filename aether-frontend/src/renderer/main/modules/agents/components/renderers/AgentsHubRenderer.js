'use strict';

/**
 * @.architecture
 * Presentation layer for AgentsHub, rendering cards and job history.
 */
class AgentsHubRenderer {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.escapeHtml = options.escapeHtml || ((text) => {
      const div = document.createElement('div');
      div.textContent = String(text);
      return div.innerHTML;
    });
    this.formatRelativeTime = options.formatRelativeTime || ((t) => String(t));
    this.formatDuration = options.formatDuration || ((ms) => `${ms}ms`);
    this.formatAgentName = options.formatAgentName || ((name) => name);
  }

  renderOndemandView(tools, toolState) {
    return `
      <div class="agents-hub-content">
        <div class="agents-grid-container">
          <div class="agents-grid">
            ${tools.map(tool => this.renderAgentCard(tool, toolState)).join('')}
          </div>
        </div>
        ${this.renderModalRecentJobs(tools, toolState)}
      </div>
    `;
  }

  renderSystemView(systemPanel) {
    return `
      <div class="agents-hub-content">
        <div class="agents-grid-container">
          <div class="agents-grid">
            ${systemPanel ? systemPanel.renderCards() : ''}
          </div>
        </div>
      </div>
    `;
  }

  renderAgentCard(tool, toolState) {
    const agent = tool.agent;
    if (!agent) return '';

    const statusClass = agent.enabled ? 'enabled' : 'disabled';
    const icon = this.getAgentIcon(agent.agent_name);
    const runState = toolState.getToolRunState(agent.agent_name);
    const isRunning = runState && (runState.status === 'running' || runState.status === 'queued' || runState.status === 'processing');
    const hasCompleted = runState && runState.status === 'completed';
    const hasFailed = runState && runState.status === 'failed';

    return `
      <div class="agent-card ${statusClass}" data-tool-name="${agent.agent_name}" data-run-status="${runState?.status || ''}">
        <div class="agent-card-body">
          <div class="agent-card-header-row">
            <h3 class="agent-card-title">${this.formatAgentName(agent.agent_name)}</h3>
            <div class="agent-card-controls">
              ${isRunning ? `
                <div class="agent-status-badge running" data-action="view-current-job" data-tool-name="${agent.agent_name}" title="${runState.status === 'queued' ? 'Queued' : 'Running'} - Click to view">
                  <div class="spinner-ring"></div>
                  <span>${runState.status === 'queued' ? 'Queued' : 'Running'}</span>
                </div>
              ` : ''}
              <label class="agent-toggle" title="Enable/Disable Agent">
                <input type="checkbox" data-agent-name="${agent.agent_name}" ${agent.enabled ? 'checked' : ''}>
                <i class="fas fa-power-off"></i>
                <span>${agent.enabled ? 'ON' : 'OFF'}</span>
              </label>
            </div>
          </div>
          <p class="agent-card-description">${this.getAgentDescription(agent.agent_name)}</p>

          <div class="agent-card-meta">
            <span class="agent-meta-item">
              <i class="fas fa-tag"></i>
              ${agent.agent_type || 'on-demand'}
            </span>
          </div>
        </div>
        <div class="agent-card-actions">
          ${agent.agent_name === 'memory' ? `
            <button class="btn-card-primary" data-action="open-memory-browser" title="View Memory Browser">
              <i class="fas fa-brain"></i> Memory Browser
            </button>
          ` : (isRunning ? `
            <button class="btn-card-primary running" data-action="view-current-job" data-tool-name="${agent.agent_name}">
              <i class="fas fa-spinner fa-spin"></i> Running...
            </button>
          ` : `
            <button class="btn-card-primary" data-action="open-tool" data-tool-name="${agent.agent_name}">
              <i class="fas fa-play"></i> Start
            </button>
          `)}
          ${agent.agent_name === 'research' ? `
            <button class="btn-card-secondary tool-card-interface" data-action="open-perplexica-interface" title="Open Research Interface">
              <i class="fas fa-window-restore"></i> Interface
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }

  renderModalRecentJobs(tools, toolState) {
    const allJobs = [];
    for (const tool of tools) {
      const agent = tool.agent;
      if (!agent) continue;

      const jobs = toolState.getToolJobs(agent.agent_name);
      if (jobs && jobs.length > 0) {
        for (const job of jobs.slice(0, 3)) {
          allJobs.push({
            ...job,
            agentName: agent.agent_name,
            agentDisplayName: this.formatAgentName(agent.agent_name)
          });
        }
      }
    }

    allJobs.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const recentJobs = allJobs.slice(0, 5);

    if (recentJobs.length === 0) return '';

    return `
      <div class="agents-recent-jobs-section">
        <div class="agents-recent-jobs-header">
          <h4><i class="fas fa-history"></i> Recent Jobs</h4>
          <span class="agents-recent-jobs-count">${recentJobs.length}</span>
        </div>
        <div class="agents-recent-jobs-list">
          ${recentJobs.map(job => {
            const jobId = job.id || job.job_id;
            const query = this.getJobQuery(job);
            const status = (job.status || 'completed').toLowerCase();
            const relativeTime = this.formatRelativeTime(job.created_at);
            return `
              <div class="agents-recent-job-item" 
                role="button" 
                tabindex="0" 
                data-action="view-specific-job" 
                data-tool-name="${job.agentName}" 
                data-job-id="${jobId}"
                title="View details for ${this.escapeHtml(query)}"
              >
                <div class="recent-job-icon">
                  <i class="fas ${this.getStatusIconSmall(status)} status-${status}"></i>
                </div>
                <div class="recent-job-content">
                  <div class="recent-job-query" title="${this.escapeHtml(query)}">${this.escapeHtml(query)}</div>
                  <div class="recent-job-meta">
                    <span class="recent-job-agent">${job.agentDisplayName}</span>
                    <span class="recent-job-time">${relativeTime}</span>
                  </div>
                </div>
                <div class="recent-job-status-badge status-${status}">
                  ${status}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  getAgentIcon(agentName) {
    const icons = {
      'research': 'search',
      'context_manager': 'database',
      'code_executor': 'code',
      'web_crawler': 'spider',
      'file_indexer': 'folder-open'
    };
    return icons[agentName] || 'robot';
  }

  getAgentDescription(agentName) {
    const descriptions = {
      'research': 'Legal research with case law and statutory analysis',
      'context_manager': 'Manages conversation context and memory',
      'code_executor': 'Executes code and scripts safely',
      'web_crawler': 'Crawls and indexes web content',
      'file_indexer': 'Indexes and searches local files'
    };
    return descriptions[agentName] || 'AI agent for specialized tasks';
  }

  getStatusIconSmall(status) {
    switch (status) {
      case 'completed': return 'fa-check-circle';
      case 'running':
      case 'processing': return 'fa-spinner fa-spin';
      case 'failed': return 'fa-exclamation-circle';
      case 'pending': return 'fa-clock';
      case 'cancelled': return 'fa-ban';
      default: return 'fa-circle';
    }
  }

  getJobQuery(job) {
    if (!job) return 'Unknown';
    
    const meta = job.metadata || job.content || {};
    let query = meta.query || meta.prompt || meta.filename || meta.intake_text || job.query || '';
    
    if (!query) {
      const toolName = String(job.agent_name || job.tool || '').toLowerCase();
      if (toolName === 'research') query = 'Research Task';
      else query = 'AI Agent Task';
    }

    if (typeof query === 'string' && query.length > 40) {
      return query.substring(0, 37) + '...';
    }
    return query;
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AgentsHubRenderer;
}
