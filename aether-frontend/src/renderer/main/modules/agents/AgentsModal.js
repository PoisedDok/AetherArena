/**
 * @.architecture
 * Incoming: MainWindow menu action, user click --- {user intent to configure agents}
 * Processing: Orchestrate components, manage state, handle interactions --- {JOB_ORCHESTRATE, JOB_DELEGATE, JOB_COORDINATE}
 * Outgoing: Backend API /v1/agent/configs, component rendering --- {updated agent configs}
 *
 * AgentsModal - REFACTORED Modular Architecture
 *
 * Orchestrates:
 * - AgentStateManager (agent/model/template/settings state)
 * - ToolStateManager (tool jobs/run state)
 * - SystemAgentPanel (system agent configuration UI)
 * - Tool components (ResearchTool)
 * - DialogManager (dialog lifecycle)
 * - Dialog components (ResearchDialog, etc)
 *
 */

'use strict';

const Toast = require('../../../shared/components/Toast');
const ToolsHubModal = require('./components/ToolsHubModal');
const { getAether } = require('../../../shared/bridge/AetherBridge');

// State managers
const AgentStateManager = require('./components/state/AgentStateManager');
const ToolStateManager = require('./components/state/ToolStateManager');

// Components
const DialogManager = require('./components/dialogs/DialogManager');
const ResultsViewerDialog = require('./components/dialogs/ResultsViewerDialog');
const AgentsHubRenderer = require('./components/renderers/AgentsHubRenderer');

// Tool components
const ResearchTool = require('./components/tools/ResearchTool');

class AgentsModal extends ToolsHubModal {
  constructor(options = {}) {
    super({
      title: 'AI Agents',
      id: options.id || 'agents-modal',
      size: options.size || 'xl',
      heightPreset: options.heightPreset || 'default',
      showFooter: true,
    });

    // Scope styles to this modal instance
    this.overlay.classList.add('agents-modal');
    this.panel.classList.add('agents-modal-panel');

    // Callbacks
    this.onSave = options.onSave || (() => {});
    this.onCancel = options.onCancel || (() => {});
    this.onOpenMemoryBrowser = options.onOpenMemoryBrowser || (() => {});
    
    // Core dependencies
    const aether = getAether();
    this.endpoint = options.endpoint || null;
    this.aetherModals = options.aetherModals || null;
    this.logger = aether?.logger || console;
    
    // State managers
    this.agentState = new AgentStateManager({ logger: this.logger });
    this.toolState = new ToolStateManager({ logger: this.logger });
    
    // Dialog manager
    this.dialogManager = new DialogManager({ logger: this.logger });
    
    // UI Renderer
    this.renderer = new AgentsHubRenderer({
      logger: this.logger,
      escapeHtml: this._escapeHtml.bind(this),
      formatRelativeTime: this._formatRelativeTime.bind(this),
      formatDuration: this._formatDuration.bind(this),
      formatAgentName: this._formatAgentName.bind(this)
    });
    
    // Tool components (will be initialized after fetching agents)
    this.tools = [];
    
    // Listener tracking
    this._listeners = [];
    this._panelListeners = [];
    this._timers = [];
    this._openSequence = 0;
    
    // Standalone dialog tracking (dialogs appended to document.body, not managed by DialogManager)
    this._standaloneDialogs = [];
    
    // Save-in-progress guard — prevents _refreshHub from re-rendering footer mid-save
    this._isSaving = false;
  }

  /**
   * Override BaseModal escape handler to handle nested dialogs
   */
  _handleEscape(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    
    // Close tool dialog first if open
    if (this.dialogManager.isOpen()) {
      this.dialogManager.close();
      return;
    }
    
    // Otherwise close modal
    this._handleCancel();
  }

  /**
   * Override BaseModal backdrop click handler
   */
  _handleBackdropClick(e) {
    if (e.target === this.overlay) {
      this._handleCancel();
    }
  }

  /**
   * Override BaseModal close button handler
   */
  _handleCloseClick() {
    this._handleCancel();
  }

  /**
   * Show the agents configuration modal
   */
  async show() {
    try {
      if (this.isOpen) return;
      if (!this.endpoint) {
        throw new Error('Endpoint not available');
      }
      await this.open();
    } catch (error) {
      this.logger.error('AgentsModal: Failed to load modal:', error);
      Toast.error('Failed to load agent configurations. Check console for details.');
    }
  }

  /**
   * Render modal content (called by BaseModal.open())
   */
  async _renderContent() {
    // Skeleton loading state (contextual to agents hub layout: header + tool cards)
    this.bodyEl.innerHTML = `
      <div class="skeleton-container">
        <div class="skeleton-row"><div class="skeleton-line skeleton-line--lg skeleton-line--thick"></div></div>
        <div class="skeleton-row"><div class="skeleton-line skeleton-line--md"></div></div>
        <div class="skeleton-row" style="margin-bottom:var(--spacing-sm)"><div class="skeleton-line skeleton-line--sm"></div><div class="skeleton-line skeleton-line--sm"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--lg" style="flex:1"></div></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--md" style="flex:1"></div></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--lg" style="flex:1"></div></div><div class="skeleton-line skeleton-line--lg"></div></div>
      </div>`;

    const seq = ++this._openSequence;
    try {
      await this.agentState.fetchAll(this.endpoint);
      if (seq !== this._openSequence || !this.isOpen) return;

      await this.toolState.prefetchAll(
        this.endpoint,
        ['research', 'memory'],
        (name) => this.agentState.findAgentByName(name)
      );
      if (seq !== this._openSequence || !this.isOpen) return;

      this._initializeTools();

      this.bodyEl.innerHTML = this._renderHub();
      const footerContent = this._renderModalFooter();
      this.footerEl.innerHTML = footerContent;
      this.footerEl.classList.toggle('hidden', !footerContent);
    } catch (error) {
      if (seq !== this._openSequence || !this.isOpen) return;
      this.logger.error('Failed to load agent configurations:', error);
      this.bodyEl.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">Failed to Load Agents</div>
          <div class="modal-empty-text">Backend may be unavailable. Please try again later.</div>
        </div>
      `;
    }
  }

  /**
   * Setup event listeners (called by BaseModal after _renderContent)
   */
  _setupEventListeners() {
    this._attachEventListeners();
    this._startPolling();
  }

  /**
   * Start periodic refresh of tool and agent state
   * @private
   */
  _startPolling() {
    this._clearTimers();
    
    const pollInterval = 5000; // 5 seconds
    
    const timerId = setInterval(async () => {
      if (document.hidden) return;
      try {
        // Refresh tool jobs and run states
        await this.toolState.prefetchJobs(
          this.endpoint,
          ['research', 'memory'],
          (name) => this.agentState.findAgentByName(name)
        );
        
        // Only refresh UI if modal is open and no dialog is blocking it
        if (this.isOpen && !this.dialogManager.isOpen()) {
          this._refreshHub();
        }
      } catch (error) {
        this.logger.warn('AgentsModal: Polling failed:', error);
      }
    }, pollInterval);
    
    this._trackTimer(timerId);
  }

  /**
   * Initialize tool components with agent state
   * @private
   */
  _initializeTools() {
    const researchAgent = this.agentState.findAgentByName('research');
    const memoryAgent = this.agentState.findAgentByName('memory');

    this.tools = [
      new ResearchTool({
        agent: researchAgent,
        endpoint: this.endpoint,
        toolState: this.toolState,
        agentState: this.agentState,
        templatesByName: this.agentState.templatesByName,
        logger: this.logger
      }),
      {
        agent: memoryAgent,
        name: 'memory'
      }
    ];
  }

  // ============================================================================
  // IMPLEMENT ToolsHubModal ABSTRACT METHODS
  // ============================================================================

  _getHubTitle() {
    return 'AI Agents';
  }

  _getHubSubtitle() {
    return 'Research and Memory';
  }

  _getViews() {
    return []; // No tabs
  }

  _renderOndemandView() {
    return this.renderer.renderOndemandView(this.tools, this.toolState);
  }

  _renderSystemView() {
    return this.renderer.renderSystemView(this.systemPanel);
  }

  _onViewChanged(viewId) {
    // Reset state when switching views
    this.agentState.setSelectedAgent(null);
  }
  
  /**
   * Format duration in milliseconds
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration
   * @private
   */
  _formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const seconds = ms / 1000;
    if (seconds < 1) return `${ms}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m ${remainder}s`;
  }

  // ============================================================================
  // EVENT HANDLING
  // ============================================================================

  /**
   * Attach event listeners
   * @private
   */
  _attachEventListeners() {
    // Clear previous listeners
    this._clearListeners();
    this._clearPanelListeners();

    // Footer buttons
    const cancelBtn = this.footerEl.querySelector('.agents-cancel');
    this._trackListener(cancelBtn, 'click', () => this._handleCancel());

    const closeBtn = this.footerEl.querySelector('.agents-close');
    this._trackListener(closeBtn, 'click', () => this._handleCancel());

    const saveBtn = this.footerEl.querySelector('.agents-save');
    this._trackListener(saveBtn, 'click', () => this._handleSave());

    // Hub actions (tabs + tool CTAs)
    this._trackListener(this.bodyEl, 'click', (e) => {
      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;
      
      this._handleAction(actionEl, e);
    });

    // Agent toggles (enable/disable agents in both views)
    this._trackListener(this.bodyEl, 'change', async (e) => {
      const input = e.target;
      if (!input || input.tagName !== 'INPUT' || input.type !== 'checkbox') return;
      
      // Handle tool agent toggles (on-demand view)
      if (input.dataset.agentName) {
        await this._handleAgentToggle(input.dataset.agentName, input.checked);
        return;
      }
      
      // Handle system agent toggles
      if (input.dataset.agentIndex) {
        const agentIndex = parseInt(input.dataset.agentIndex, 10);
        if (Number.isFinite(agentIndex)) {
          await this._handleSystemAgentToggle(agentIndex, input.checked);
        }
        return;
      }
      
      // Legacy toggle-agent action
      if (input.dataset.action === 'toggle-agent') {
        await this._handleToolToggle(input);
      }
    });

    // Both views now use card grid, no special panel listeners needed
    // (kept for compatibility with old system view if needed)
    if (this.activeView === 'system' && this.systemPanel) {
      // System panel listeners for legacy sidebar view (if used)
      this.systemPanel.setupListeners(this.bodyEl, (el, evt, handler, opts) => {
        this._trackListener(el, evt, handler, opts);
      });
    }
  }

  /**
   * Handle action button clicks
   * @param {HTMLElement} actionEl - Element with data-action
   * @param {Event} e - Click event
   * @private
   */
  _handleAction(actionEl, e) {
    const action = actionEl.dataset.action;

    if (action === 'open-memory-browser') {
      this.onOpenMemoryBrowser();
      this.close();
      return;
    }

    if (action === 'set-view') {
      const view = actionEl.dataset.view;
      if (view === 'ondemand' || view === 'system') {
        this.switchView(view);
        this._refreshHub();
      }
      return;
    }

    if (action === 'open-tool') {
      const toolName = actionEl.dataset.toolName;
      const tool = this.tools.find(t => t.name === toolName);
      if (!tool) {
        Toast.error('Tool not available.');
        return;
      }
      this._openToolDialog(tool).catch((error) => {
        this.logger.error('AgentsModal: Failed to open tool dialog:', error);
        Toast.error(`Failed to open tool: ${error.message}`);
      });
      return;
    }

    if (action === 'view-history') {
      const toolName = actionEl.dataset.toolName;
      this._openJobHistory(toolName);
      return;
    }
    
    if (action === 'view-current-job' || action === 'view-last-job') {
      const toolName = actionEl.dataset.toolName;
      const runState = this.toolState.getToolRunState(toolName);
      const jobId = runState?.job_id || runState?.id || runState?.output_id || null;
      this._openJobHistory(toolName, jobId);
      return;
    }

    if (action === 'view-specific-job') {
      const toolName = actionEl.dataset.toolName;
      const jobId = actionEl.dataset.jobId;
      this._openJobHistory(toolName, jobId);
      return;
    }

    if (action === 'configure-agent') {
      const agentIndex = parseInt(actionEl.dataset.agentIndex, 10);
      if (Number.isFinite(agentIndex)) {
        this._openAgentConfigDialog(agentIndex);
      }
      return;
    }

    if (action === 'tool-invoke') {
      const toolName = actionEl.dataset.tool;
      const tool = this.tools.find(t => t.name === toolName);
      if (!tool) {
        Toast.error('Tool not available.');
        return;
      }
      this._openToolDialog(tool).catch((error) => {
        this.logger.error('AgentsModal: Failed to open tool dialog:', error);
        Toast.error(`Failed to open tool: ${error.message}`);
      });
      return;
    }

    if (action === 'open-job-history') {
      const toolEl = e.target.closest('[data-tool]');
      const toolName = toolEl?.dataset?.tool || null;
      this._openJobHistory(toolName);
      return;
    }

    if (action === 'open-research-history') {
      this._openResearchHistory();
      return;
    }

    if (action === 'open-perplexica-interface') {
      this._openAgentDashboard();
      return;
    }

    if (action === 'view-results') {
      const toolName = actionEl.dataset.tool;
      this._viewToolResults(toolName);
      return;
    }
    
    if (action === 'close-dialog') {
      this.dialogManager.close();
      return;
    }
    
    if (action === 'save-agent-config') {
      const agentIndex = parseInt(actionEl.dataset.agentIndex, 10);
      if (Number.isFinite(agentIndex)) {
        this._saveAgentConfigFromDialog(agentIndex);
      }
      return;
    }
  }

  /**
   * Handle tool toggle (enable/disable)
   * @param {HTMLInputElement} input - Toggle input element
   * @private
   */
  async _handleToolToggle(input) {
    const name = input.dataset.agentName;
    const agent = this.agentState.findAgentByName(name);
    if (!agent) return;
    
    const previous = Boolean(agent.enabled);
    const next = Boolean(input.checked);
    agent.enabled = next;

      // Tools view: persist immediately (no hidden "Save" required)
      try {
        input.disabled = true;
      await this.endpoint.updateAgentConfig(agent.agent_name, { enabled: next });
      Toast.success(`${this._formatAgentName(agent.agent_name)} ${next ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      agent.enabled = previous;
      input.checked = previous;
      Toast.error(`Failed to update ${this._formatAgentName(agent.agent_name)}: ${error.message}`);
    } finally {
      input.disabled = false;
      this._refreshHub();
    }
  }
  
  /**
   * Handle on-demand agent toggle
   * @param {string} agentName - Agent name
   * @param {boolean} enabled - New enabled state
   * @private
   */
  async _handleAgentToggle(agentName, enabled) {
    const agent = this.agentState.findAgentByName(agentName);
    if (!agent) return;
    
    const previous = Boolean(agent.enabled);
    agent.enabled = enabled;

    try {
      await this.endpoint.updateAgentConfig(agent.agent_name, { enabled });
      Toast.success(`${this._formatAgentName(agent.agent_name)} ${enabled ? 'enabled' : 'disabled'}.`);
      this._refreshHub();
    } catch (error) {
      agent.enabled = previous;
      Toast.error(`Failed to update ${this._formatAgentName(agent.agent_name)}: ${error.message}`);
      this._refreshHub();
    }
  }
  
  /**
   * Handle system agent toggle
   * @param {number} agentIndex - Agent index
   * @param {boolean} enabled - New enabled state
   * @private
   */
  async _handleSystemAgentToggle(agentIndex, enabled) {
    const agent = this.agentState.getAgent(agentIndex);
    if (!agent) return;
    
    const previous = Boolean(agent.enabled);
    agent.enabled = enabled;

    try {
      await this.endpoint.updateAgentConfig(agent.agent_name, { enabled });
      Toast.success(`${this._formatAgentName(agent.agent_name)} ${enabled ? 'enabled' : 'disabled'}.`);
      this._refreshHub();
    } catch (error) {
      agent.enabled = previous;
      Toast.error(`Failed to update ${this._formatAgentName(agent.agent_name)}: ${error.message}`);
      this._refreshHub();
    }
  }

  /**
   * Open tool dialog
   * @param {ToolComponent} tool - Tool component
   * @private
   */
  async _openToolDialog(tool) {
    if (!tool) {
      throw new Error('Tool is required');
    }

    try {
      // Create dialog
      const dialog = tool.createDialog();
      const dialogEl = dialog.create();
      
      // Open with DialogManager
      this.dialogManager.open(dialogEl);
      
      // Setup dialog listeners
      dialog.setupListeners(
        this.dialogManager,
        (force) => this._refreshHub(force),
        () => this._openJobHistory()
      );
      
    } catch (error) {
      this.logger.error('AgentsModal: Failed to create tool dialog:', error);
      Toast.error(`Failed to open dialog: ${error.message}`);
    }
  }

  /**
   * View tool results
   * @param {string} toolName - Tool name
   * @private
   */
  _viewToolResults(toolName) {
    const state = this.toolState.getToolRunState(toolName);
    if (!state || !state.results) {
      Toast.warning('No results available');
      return;
    }

    // Create results viewer dialog
    const dialog = new ResultsViewerDialog({
      toolName: toolName,
      results: state.results,
      logger: this.logger
    });

    const dialogEl = dialog.create();
    this.dialogManager.open(dialogEl);
    dialog.setupListeners(this.dialogManager);
  }
  
  /**
   * Open agent configuration dialog
   * @param {number} agentIndex - Agent index
   * @private
   */
  _openAgentConfigDialog(agentIndex) {
    // Select the agent
    this.agentState.setSelectedAgent(agentIndex);
    
    // Create and open config dialog
    const agent = this.agentState.getAgent(agentIndex);
    if (!agent) return;
    
    // Create dialog wrapper element
    const dialogWrapper = document.createElement('div');
    dialogWrapper.className = 'tool-dialog';
    dialogWrapper.innerHTML = `
      <div class="tool-dialog-overlay" data-action="close-dialog"></div>
      <div class="tool-dialog-content agent-config-dialog">
        <div class="dialog-header">
          <h3>${this._formatAgentName(agent.agent_name)} Configuration</h3>
          <button class="dialog-close" data-action="close-dialog">✕</button>
        </div>
        <div class="dialog-body">
          ${this.systemPanel ? this.systemPanel._renderConfigPanelContent(agent, agentIndex) : ''}
        </div>
        <div class="dialog-footer">
          <button class="btn-secondary" data-action="close-dialog">Cancel</button>
          <button class="btn-primary" data-action="save-agent-config" data-agent-index="${agentIndex}">Save</button>
        </div>
      </div>
    `;
    
    this.dialogManager.open(dialogWrapper);
    
    // Setup action handlers within dialog
    this.dialogManager.trackListener(dialogWrapper, 'click', (e) => {
      const actionEl = e.target.closest('[data-action]');
      if (actionEl) {
        this._handleAction(actionEl, e);
      }
    });
    
    // Setup config panel listeners within dialog
    if (this.systemPanel) {
      this.systemPanel.setupListeners(dialogWrapper, (el, evt, handler, opts) => {
        this.dialogManager.trackListener(el, evt, handler, opts);
      });
    }
  }

  /**
   * Open job history modal
   * @param {string} toolName - Optional tool name to filter by
   * @param {string} jobId - Optional job ID to show details for
   * @private
   */
  _openJobHistory(toolName = null, jobId = null) {
    try {
      const modals = this.aetherModals;
      if (modals && typeof modals.get === 'function') {
        const modal = modals.get('jobHistory');
        if (modal && typeof modal.show === 'function') {
          // If toolName provided, filter to that agent
          if (toolName && typeof modal.setAgentFilter === 'function') {
            modal.setAgentFilter(toolName);
          }

          // Show modal
          modal.show();

          // If jobId provided, open details for that job after a short delay (for modal open animation)
          if (jobId && typeof modal.showJobDetailsById === 'function') {
            const timerId = setTimeout(() => modal.showJobDetailsById(jobId), 300);
            this._trackTimer(timerId);
          }
          return;
        }
      }
      
      // FALLBACK: If JobHistoryModal is unavailable, try to open details dialog directly
      if (jobId) {
        this.logger.info('AgentsModal: JobHistoryModal not available, attempting direct job details open');
        this._showDirectJobDetails(jobId);
        return;
      }

      this.logger.warn('AgentsModal: Job history modal not available');
      Toast.warning('Job history not available');
    } catch (error) {
      this.logger.error('AgentsModal: Failed to open job history modal:', error);
      Toast.error('Failed to open job history');
    }
  }

  /**
   * Fallback to open job details directly if main history modal is missing
   * @private
   */
  async _showDirectJobDetails(jobId) {
    try {
      const job = await this.endpoint.api.get(`/v1/agent/status/${jobId}`);
      if (!job) throw new Error('Job not found');
      
      // Normalize
      if (!job.id && job.job_id) job.id = job.job_id;
      
      const JobDetailsDialog = require('../jobs/JobDetailsDialog');
      const dialog = new JobDetailsDialog({
        job: job,
        endpoint: this.endpoint,
        logger: this.logger
      });
      
      const dialogEl = dialog.create();
      this.dialogManager.open(dialogEl);
      dialog.setupListeners(this.dialogManager);
    } catch (error) {
      this.logger.error('AgentsModal: Direct job details open failed:', error);
      Toast.error('Could not load job details');
    }
  }

  /**
   * Open research history dialog
   * @private
   */
  async _openResearchHistory() {
    const dialog = document.createElement('div');
    dialog.className = 'tool-dialog';
    dialog.innerHTML = `
      <div class="tool-dialog-overlay"></div>
      <div class="tool-dialog-content tool-dialog-research-history">
        <div class="tool-dialog-header">
          <h3><i class="fas fa-history"></i> Research History</h3>
          <button class="tool-dialog-close" aria-label="Close">&times;</button>
        </div>
        <div class="tool-dialog-body">
          <div class="tool-dialog-status is-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <span>Loading research history...</span>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);
    this._standaloneDialogs.push(dialog);
    requestAnimationFrame(() => dialog.classList.add('visible'));

    const closeBtn = dialog.querySelector('.tool-dialog-close');
    const overlay = dialog.querySelector('.tool-dialog-overlay');
    const bodyEl = dialog.querySelector('.tool-dialog-body');
    
    const close = () => {
      dialog.classList.remove('visible');
      const timerId = setTimeout(() => {
        dialog.remove();
        this._standaloneDialogs = this._standaloneDialogs.filter(d => d !== dialog);
      }, 300);
      this._trackTimer(timerId);
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', close);

    try {
      const history = await this.endpoint.listResearchHistory({ limit: 50 });
      
      if (!history || history.length === 0) {
        bodyEl.innerHTML = `
          <div class="tool-dialog-status">
            <i class="fas fa-inbox"></i>
            <span>No research history yet</span>
          </div>
        `;
        return;
      }

      const items = history.map((item) => {
        const createdAt = new Date(item.created_at);
        const content = item.content || {};
        const query = content.query || 'Unknown query';
        const timeMs = content.time_ms || 0;
        const sources = content.sources || [];
        const modelUsed = content.model_used || 'unknown';

        return `
          <div class="research-history-item">
            <div class="research-history-header">
              <div class="research-history-query">${this._escapeHtml(query)}</div>
              <div class="research-history-time">${this._formatRelativeTime(createdAt)}</div>
            </div>
            <div class="research-history-meta">
              <span><i class="fas fa-clock"></i> ${this._formatDuration(timeMs)}</span>
              <span><i class="fas fa-database"></i> ${sources.length} sources</span>
              <span><i class="fas fa-robot"></i> ${this._escapeHtml(modelUsed)}</span>
            </div>
            <button class="btn-ghost btn-sm research-history-view" data-output-id="${item.id}">
              <i class="fas fa-eye"></i> View Results
            </button>
          </div>
        `;
      }).join('');

      bodyEl.innerHTML = `<div class="research-history-list">${items}</div>`;

      bodyEl.querySelectorAll('.research-history-view').forEach((btn) => {
        btn.addEventListener('click', () => {
          const outputId = btn.dataset.outputId;
          const historyItem = history.find(h => h.id === outputId);
          if (historyItem && historyItem.content && historyItem.content.results) {
            close();
            this._viewHistoricalResearch(historyItem);
          }
        });
      });

    } catch (error) {
      this.logger.error('AgentsModal: Failed to load research history:', error);
      bodyEl.innerHTML = `
        <div class="tool-dialog-status is-error">
          <i class="fas fa-exclamation-circle"></i>
          <span>Failed to load history</span>
        </div>
      `;
    }
  }

  /**
   * Public API to open agent dashboard from other modules
   */
  openAgentDashboard() {
    this._openAgentDashboard();
  }

  /**
   * Open agent research dashboard dialog
   * @private
   */
  async _openAgentDashboard() {
    try {
      const aether = getAether();
      if (!aether || !aether.ipc) {
        this.logger.error('AgentsModal: IPC not available');
        return;
      }
      
      aether.ipc.send('window:open-research');
      this.logger.info('AgentsModal: Agent dashboard opened');
      
    } catch (error) {
      this.logger.error('AgentsModal: Failed to open agent dashboard:', error);
      Toast.error(`Failed to open dashboard: ${error.message}`);
    }
  }

  /**
   * View historical research results
   * @param {Object} historyItem - History item object
   * @private
   */
  _viewHistoricalResearch(historyItem) {
    const content = historyItem.content || {};
    const query = content.query || 'Research Results';

    const dialog = new ResultsViewerDialog({
      toolName: query,
      results: content,
      logger: this.logger
    });

    const dialogEl = dialog.create();
    this.dialogManager.open(dialogEl);
    dialog.setupListeners(this.dialogManager);
  }

  /**
   * Update DOM surgically to prevent layout jank and flicker
   * @param {HTMLElement} parent - Parent node to update
   * @param {string} newHtml - New HTML content
   * @private
   */
  _updateDOM(parent, newHtml) {
    if (parent.innerHTML === newHtml) return;
    
    const template = document.createElement('template');
    template.innerHTML = newHtml;
    
    const morphChildren = (oldParent, newParent) => {
      const oldChildren = Array.from(oldParent.childNodes);
      const newChildren = Array.from(newParent.childNodes);
      const max = Math.max(oldChildren.length, newChildren.length);
      
      for (let i = 0; i < max; i++) {
        const oldChild = oldChildren[i];
        const newChild = newChildren[i];
        
        if (!oldChild && newChild) {
          oldParent.appendChild(newChild.cloneNode(true));
        } else if (oldChild && !newChild) {
          oldParent.removeChild(oldChild);
        } else if (oldChild.nodeType !== newChild.nodeType || oldChild.nodeName !== newChild.nodeName) {
          oldParent.replaceChild(newChild.cloneNode(true), oldChild);
        } else if (oldChild.nodeType === Node.TEXT_NODE) {
          if (oldChild.textContent !== newChild.textContent) {
            oldChild.textContent = newChild.textContent;
          }
        } else if (oldChild.nodeType === Node.ELEMENT_NODE) {
          if (!oldChild.isEqualNode(newChild)) {
            // Update attributes
            const newAttrs = newChild.attributes;
            for (let j = oldChild.attributes.length - 1; j >= 0; j--) {
              const attrName = oldChild.attributes[j].name;
              if (!newChild.hasAttribute(attrName) && attrName !== 'value') {
                oldChild.removeAttribute(attrName);
              }
            }
            for (let j = 0; j < newAttrs.length; j++) {
              if (oldChild.getAttribute(newAttrs[j].name) !== newAttrs[j].value) {
                oldChild.setAttribute(newAttrs[j].name, newAttrs[j].value);
              }
            }
            // Sync value property for inputs
            if ('value' in newChild && oldChild.value !== newChild.value) {
              oldChild.value = newChild.value;
            }
            if ('checked' in newChild && oldChild.checked !== newChild.checked) {
              oldChild.checked = newChild.checked;
            }
            // Recurse
            morphChildren(oldChild, newChild);
          }
        }
      }
    };
    
    morphChildren(parent, template.content);
  }

  /**
   * Refresh hub (re-render after state changes)
   * @param {boolean} forcePrefetch - If true, prefetch jobs before rendering
   * @private
   */
  async _refreshHub(forcePrefetch = false) {
    // Guard: do not re-render while a save operation is in progress.
    // A poll-triggered _refreshHub during _handleSave would replace the footer,
    // creating a fresh enabled Save button and allowing double-submit.
    if (this._isSaving) return;

    if (forcePrefetch) {
      await this.toolState.prefetchJobs(
        this.endpoint,
        ['research'],
        (name) => this.agentState.findAgentByName(name)
      );
    }

    // Clear listeners bound to elements that will be replaced
    this._clearPanelListeners();
    
    // Re-render surgically
    const newHubHtml = this._renderHub();
    if (this.bodyEl.innerHTML.trim() === '') {
      this.bodyEl.innerHTML = newHubHtml;
    } else {
      this._updateDOM(this.bodyEl, newHubHtml);
    }
    
    const footerContent = this._renderModalFooter();
    if (this.footerEl.innerHTML !== footerContent) {
      this._updateDOM(this.footerEl, footerContent);
    }
    this.footerEl.classList.toggle('hidden', !footerContent);
    
    // Re-attach listeners
    this._attachEventListeners();
  }

  // ============================================================================
  // SAVE HANDLING
  // ============================================================================

  /**
   * Handle cancel action
   * @private
   */
  _handleCancel() {
    this.close();
    this.onCancel();
  }

  /**
   * Handle save action
   * @private
   */
  async _handleSave() {
    this._isSaving = true;
    try {
      const saveBtn = this.footerEl.querySelector('.agents-save');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
      }

      const dirtyNames = this.agentState.getDirtyAgents();
      if (!dirtyNames.length) {
        Toast.success('No changes to save.');
        this.close();
        this.onSave(this.agentState.agents);
        return;
      }

      // Save all dirty agents
      for (const agentName of dirtyNames) {
        const agent = this.agentState.findAgentByName(agentName);
        if (!agent) {
          throw new Error(`Dirty agent missing from list: ${agentName}`);
        }
        await this._saveAgentConfig(agent);
      }
      
      this.logger.info('AgentsModal: All agent configurations saved successfully');
      Toast.success('Agent configurations saved.');
      this.agentState.clearDirty();
      this.close();
      this.onSave(this.agentState.agents);
      
    } catch (error) {
      this.logger.error('AgentsModal: Failed to save agent configurations:', error);
      Toast.error(`Failed to save configurations: ${error.message}`);
      
      const saveBtn = this.footerEl.querySelector('.agents-save');
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    } finally {
      this._isSaving = false;
    }
  }

  /**
   * Save agent configuration to backend
   * @param {Object} agent - Agent object
   * @private
   */
  async _saveAgentConfig(agent) {
    const payload = {
      enabled: agent.enabled,
      model_name: agent.model_name,
      prompt_template: agent.prompt_template,
      execution_trigger: agent.execution_trigger,
      trigger_frequency: agent.trigger_frequency,
      configuration: agent.configuration || {}
    };
    
    await this.endpoint.updateAgentConfig(agent.agent_name, payload);
    this.logger.info(`AgentsModal: Saved configuration for agent: ${agent.agent_name}`);
  }
  
  /**
   * Save agent configuration from dialog
   * @param {number} agentIndex - Agent index
   * @private
   */
  async _saveAgentConfigFromDialog(agentIndex) {
    const agent = this.agentState.getAgent(agentIndex);
    if (!agent) return;
    
    const dialogEl = this.dialogManager.getDialog();
    if (!dialogEl) return;
    
    try {
      // Collect form values from dialog
      const modelSelect = dialogEl.querySelector('.config-model-select');
      const triggerSelect = dialogEl.querySelector('.config-trigger-select');
      const frequencyInput = dialogEl.querySelector('.config-frequency-input');
      const promptTextarea = dialogEl.querySelector('.config-prompt-textarea');
      
      if (modelSelect) agent.model_name = modelSelect.value;
      if (triggerSelect) agent.execution_trigger = triggerSelect.value;
      if (frequencyInput) agent.trigger_frequency = parseInt(frequencyInput.value, 10);
      if (promptTextarea) agent.prompt_template = promptTextarea.value;
      
      // Save to backend
      await this._saveAgentConfig(agent);
      Toast.success('Configuration saved.');
      this.dialogManager.close();
      this._refreshHub();
      
    } catch (error) {
      this.logger.error('Failed to save agent config from dialog:', error);
      Toast.error(`Failed to save: ${error.message}`);
    }
  }

  // ============================================================================
  // LIFECYCLE MANAGEMENT
  // ============================================================================

  /**
   * Cleanup (called by BaseModal on close)
   * @private
   */
  _cleanup() {
    this._openSequence++;
    this._clearListeners();
    this._clearPanelListeners();
    this._clearTimers();
    this.dialogManager.cleanup();
    
    // Remove any standalone dialogs still in document.body
    for (const dialog of this._standaloneDialogs) {
      try { dialog.remove(); } catch (_) { /* already removed */ }
    }
    this._standaloneDialogs = [];
    
    this.agentState.setSelectedAgent(null);
    this.activeView = 'ondemand';
    this.agentState.clearDirty();
  }

  /**
   * Track event listener for cleanup
   * @private
   */
  _trackListener(element, event, handler, options) {
    if (!element || !event || !handler) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  /**
   * Track panel listener (for config panel, cleared on panel refresh)
   * @private
   */
  _trackPanelListener(element, event, handler, options) {
    if (!element || !event || !handler) return;
    element.addEventListener(event, handler, options);
    this._panelListeners.push({ element, event, handler, options });
  }

  /**
   * Clear all listeners
   * @private
   */
  _clearListeners() {
    this._listeners.forEach(({ element, event, handler, options }) => {
      element?.removeEventListener(event, handler, options);
    });
    this._listeners = [];
  }

  /**
   * Clear panel listeners
   * @private
   */
  _clearPanelListeners() {
    this._panelListeners.forEach(({ element, event, handler, options }) => {
      element?.removeEventListener(event, handler, options);
    });
    this._panelListeners = [];
  }

  /**
   * Track timer for cleanup
   * @private
   */
  _trackTimer(timerId) {
    if (timerId) {
      this._timers.push(timerId);
    }
  }

  /**
   * Clear all timers
   * @private
   */
  _clearTimers() {
    this._timers.forEach(timerId => {
      clearInterval(timerId);
      clearTimeout(timerId);
    });
    this._timers = [];
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Format agent name for display
   * @param {string} agentName - Raw agent name
   * @returns {string} Formatted display name
   * @private
   */
  _formatAgentName(agentName) {
    const template = this.agentState.templatesByName?.[agentName];
    if (template?.display_name) {
      return template.display_name;
    }
    return agentName.charAt(0).toUpperCase() + agentName.slice(1);
  }

  /**
   * Format timestamp to relative time
   * @param {Date|string} timestamp - Timestamp to format
   * @returns {string} Relative time string
   * @private
   */
  _formatRelativeTime(timestamp) {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return String(timestamp || '—');
    
    const diffMs = Date.now() - date.getTime();
    if (diffMs < 0) return 'just now'; // Future timestamp (clock skew) — clamp to "just now"
    const diffSec = Math.floor(diffMs / 1000);
    
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 48) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
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
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AgentsModal;
}

// Global registration
if (typeof window !== 'undefined') {
  window.AgentsModal = AgentsModal;
}
