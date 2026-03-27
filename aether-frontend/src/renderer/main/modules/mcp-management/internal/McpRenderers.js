'use strict';

const McpUtils = require('./McpUtils');

/**
 * Presentation Layer for MCP Management
 * Pure UI generation and strict lifecycle listener management.
 */
class McpRenderers {
  constructor(containerEl, stateController, callbacks) {
    this.containerEl = containerEl;
    this.state = stateController;
    this.callbacks = callbacks; // { onToggleServer, onInstallDiscover, onSubmitForm, onCancelForm, onRegisterClick, onEditClick, onDeleteClick, onViewToolsClick, onDiscoverTabClick, onMyServersTabClick, onRetryDiscoverClick, onFetchDiscoverServers }
    
    // Lifecycle tracking
    this._listeners = [];
    this._discoverListeners = [];
    this._toolsListeners = [];
    this._timers = [];
    this._subModalEl = null;
  }

  /**
   * Render the main UI based on current state
   */
  render() {
    this._clearMainListeners();
    this.containerEl.innerHTML = '';
    
    if (this.state.isRegistering || this.state.editingServerId) {
      this.renderRegistrationForm();
    } else if (this.state.activeTab === 'discover') {
      this.renderDiscoverList();
    } else {
      this._renderActionBar();
      this.renderServerList();
    }
  }

  /**
   * Render the action bar for My Servers view
   * @private
   */
  _renderActionBar() {
    const actionBar = document.createElement('div');
    actionBar.className = 'modal-search-bar modal-search-with-action modal-action-bar';
    actionBar.innerHTML = `
      <div class="modal-action-spacer"></div>
      <button class="btn-secondary btn-sm" id="btn-browse-mcp" style="margin-right: 8px; display: flex; align-items: center;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="2" y1="12" x2="22" y2="12"></line>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
        </svg>
        Browse MCPs
      </button>
      <button class="btn-primary btn-sm" id="btn-add-mcp" title="Register MCP Server" style="display: flex; align-items: center;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        Add MCP
      </button>
    `;
    
    const browseBtn = actionBar.querySelector('#btn-browse-mcp');
    this._trackListener(browseBtn, 'click', () => {
      if (this.callbacks.onDiscoverTabClick) this.callbacks.onDiscoverTabClick();
    });
    
    const registerBtn = actionBar.querySelector('#btn-add-mcp');
    this._trackListener(registerBtn, 'click', () => {
      if (this.callbacks.onRegisterClick) this.callbacks.onRegisterClick();
    });
    
    this.containerEl.appendChild(actionBar);
  }

  /**
   * Render server list
   */
  renderServerList() {
    const listContainer = document.createElement('div');
    listContainer.className = 'mcp-server-list';
    
    if (this.state.servers.length === 0) {
      listContainer.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">No MCP Servers</div>
          <div class="modal-empty-text">Register your first MCP server to extend Aether's capabilities</div>
        </div>
      `;
      this.containerEl.appendChild(listContainer);
      return;
    }
    
    this.state.servers.forEach(server => {
      const cardEl = this.createServerCard(server);
      listContainer.appendChild(cardEl);
    });
    
    this.containerEl.appendChild(listContainer);
  }

  /**
   * Create server card element
   */
  createServerCard(server) {
    const card = document.createElement('div');
    card.className = 'modal-card mcp-server-card';
    card.dataset.serverId = server.server_id || server.id;
    
    const header = document.createElement('div');
    header.className = 'modal-card-header';
    
    const titleRow = document.createElement('div');
    titleRow.className = 'modal-card-title-row';
    
    const isEnabled = server.enabled !== false;
    const isRunning = server.status === 'active' || server.status === 'running';
    const isError = server.status === 'error';
    
    let indicatorColor;
    let statusTitle;
    if (!isEnabled) {
      indicatorColor = 'var(--color-text-disabled)';
      statusTitle = 'disabled';
    } else if (isError) {
      indicatorColor = 'var(--color-error)';
      statusTitle = 'error';
    } else if (isRunning) {
      indicatorColor = 'var(--color-success)';
      statusTitle = 'running';
    } else {
      indicatorColor = 'var(--color-warning)';
      statusTitle = server.status || 'stopped';
    }
    
    const statusIndicator = document.createElement('span');
    statusIndicator.className = 'status-indicator';
    statusIndicator.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none"><circle cx="4" cy="4" r="3" fill="${indicatorColor}"/></svg>`;
    statusIndicator.title = statusTitle;
    
    const title = document.createElement('div');
    title.className = 'modal-card-title';
    title.style.display = 'flex';
    title.style.alignItems = 'center';
    title.style.gap = '8px';
    
    let iconSvg = '';
    if (server.name === 'slack_mcp') {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #E01E5A;"><path d="M22.08 9.14a2.22 2.22 0 1 0-2.22-2.22v2.22h2.22z"/><path d="M17.64 9.14a2.22 2.22 0 1 0 0-4.44H13.2a2.22 2.22 0 0 0 0 4.44h4.44z"/><path d="M14.86 22.08a2.22 2.22 0 1 0 2.22-2.22h-2.22v2.22z"/><path d="M14.86 17.64a2.22 2.22 0 1 0 4.44 0V13.2a2.22 2.22 0 0 0-4.44 0v4.44z"/><path d="M1.92 14.86a2.22 2.22 0 1 0 2.22 2.22v-2.22H1.92z"/><path d="M6.36 14.86a2.22 2.22 0 1 0 0 4.44h4.44a2.22 2.22 0 0 0 0-4.44H6.36z"/><path d="M9.14 1.92a2.22 2.22 0 1 0-2.22 2.22h2.22V1.92z"/><path d="M9.14 6.36a2.22 2.22 0 1 0-4.44 0v4.44a2.22 2.22 0 0 0 4.44 0V6.36z"/></svg>`;
    } else if (server.name === 'telegram_mcp') {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #2AABEE;"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>`;
    } else if (server.name === 'whatsapp_mcp') {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #25D366;"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
    } else if (server.name === 'filesystem_mcp') {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>`;
    } else if (server.name === 'file_indexing_mcp') {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary);"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
    }
    
    title.innerHTML = iconSvg;
    const nameSpan = document.createElement('span');
    nameSpan.textContent = server.display_name || server.name;
    title.appendChild(nameSpan);
    
    const statusText = document.createElement('span');
    statusText.className = 'status-text';
    if (!isEnabled) {
      statusText.textContent = ' (disabled)';
    } else if (!isRunning) {
      statusText.textContent = ` (${server.status || 'stopped'})`;
    }
    title.appendChild(statusText);
    
    titleRow.appendChild(statusIndicator);
    titleRow.appendChild(title);
    
    const actions = document.createElement('div');
    actions.className = 'modal-card-actions';
    
    const toggleContainer = document.createElement('label');
    toggleContainer.className = 'aether-switch';
    toggleContainer.title = isEnabled ? 'Enabled (click to disable)' : 'Disabled (click to enable)';
    
    toggleContainer.innerHTML = `
      <input type="checkbox" ${isEnabled ? 'checked' : ''} />
      <span class="aether-switch-track"><span class="aether-switch-thumb"></span></span>
      <span>${isEnabled ? 'Enabled' : 'Disabled'}</span>
    `;
    
    this._trackListener(toggleContainer, 'click', (e) => {
      e.preventDefault(); 
      e.stopPropagation();
      
      // Visual feedback while starting/stopping
      const checkbox = toggleContainer.querySelector('input');
      const track = toggleContainer.querySelector('.aether-switch-track');
      if (checkbox) checkbox.disabled = true;
      if (track) track.style.opacity = '0.5';
      
      if (this.callbacks.onToggleServer) {
        this.callbacks.onToggleServer(server.server_id || server.id, server.name, !isEnabled);
      }
    });
    
    const toolsBtn = document.createElement('button');
    toolsBtn.className = 'modal-action-btn';
    toolsBtn.title = 'View Tools';
    toolsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>';
    this._trackListener(toolsBtn, 'click', (e) => {
      e.stopPropagation();
      if (this.callbacks.onViewToolsClick) this.callbacks.onViewToolsClick(server.server_id || server.id, server.display_name || server.name);
    });
    
    const editBtn = document.createElement('button');
    editBtn.className = 'modal-action-btn';
    editBtn.title = 'Edit';
    editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
    this._trackListener(editBtn, 'click', (e) => {
      e.stopPropagation();
      if (this.callbacks.onEditClick) this.callbacks.onEditClick(server.server_id || server.id);
    });
    
    const isNative = ['slack_mcp', 'telegram_mcp', 'whatsapp_mcp', 'filesystem_mcp', 'file_indexing_mcp'].includes(server.name);
    
    if (isEnabled && (server.name === 'whatsapp_mcp' || server.name === 'telegram_mcp' || server.name === 'slack_mcp')) {
      const setupBtn = document.createElement('button');
      setupBtn.className = 'modal-action-btn';
      
      let title = 'Setup / Connect';
      if (server.name === 'whatsapp_mcp') title = 'Setup / Connect (QR Code)';
      if (server.name === 'telegram_mcp') title = 'Setup / Connect (Login)';
      if (server.name === 'slack_mcp') title = 'Setup / Connect (Token)';
      setupBtn.title = title;
      
      setupBtn.innerHTML = server.name === 'whatsapp_mcp' 
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><rect x="7" y="7" width="3" height="3"></rect><rect x="14" y="7" width="3" height="3"></rect><rect x="7" y="14" width="3" height="3"></rect><rect x="14" y="14" width="3" height="3"></rect></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><polyline points="10 17 15 12 10 7"></polyline><line x1="15" y1="12" x2="3" y2="12"></line></svg>';
      
      this._trackListener(setupBtn, 'click', (e) => {
        e.stopPropagation();
        if (this.callbacks.onSetupClick) this.callbacks.onSetupClick(server.server_id || server.id, server.name);
      });
      actions.appendChild(setupBtn);
    }
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'modal-action-btn danger';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
    if (!isNative) {
      this._trackListener(deleteBtn, 'click', (e) => {
        e.stopPropagation();
        if (this.callbacks.onDeleteClick) this.callbacks.onDeleteClick(server.server_id || server.id, server.display_name || server.name);
      });
    } else {
      deleteBtn.style.display = 'none';
    }
    
    actions.appendChild(toggleContainer);
    actions.appendChild(toolsBtn);
    actions.appendChild(editBtn);
    if (!isNative) {
      actions.appendChild(deleteBtn);
    }
    
    header.appendChild(titleRow);
    header.appendChild(actions);
    
    const info = document.createElement('div');
    info.className = 'modal-card-meta';
    const serverType = server.server_type || 'local';
    const toolsCount = server.tools_count || 0;
    const lastCheck = McpUtils.formatDate(server.last_health_check);
    info.innerHTML = `${serverType.charAt(0).toUpperCase() + serverType.slice(1)} &bull; ${toolsCount} tools &bull; Last check: ${lastCheck}`;
    
    // Add auth status container for native chat MCPs
    if (isNative && ['whatsapp_mcp', 'telegram_mcp', 'slack_mcp'].includes(server.name)) {
      const authSpan = document.createElement('span');
      authSpan.id = `auth-status-${server.server_id || server.id}`;
      authSpan.className = 'auth-status-indicator';
      authSpan.style.marginLeft = '8px';
      authSpan.style.fontWeight = '500';
      if (isEnabled && isRunning) {
        authSpan.style.color = 'var(--color-warning)';
        authSpan.innerHTML = '&bull; Checking auth...';
      } else {
        authSpan.style.color = 'var(--text-tertiary)';
        authSpan.innerHTML = '&bull; Not running';
      }
      info.appendChild(authSpan);
    }
    
    card.appendChild(header);
    card.appendChild(info);

    if (server.description) {
      const desc = document.createElement('div');
      desc.className = 'modal-card-description';
      desc.textContent = server.description;
      card.appendChild(desc);
    }
    
    return card;
  }

  /**
   * Render discover list
   */
  renderDiscoverList() {
    const listContainer = document.createElement('div');
    listContainer.className = 'mcp-server-list'; 
    
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.marginBottom = '16px';
    header.style.width = '100%';
    header.innerHTML = `
      <button class="btn-icon" id="btn-discover-back" style="margin-right: 12px; padding: 4px;" title="Back to My Servers">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"></line>
          <polyline points="12 19 5 12 12 5"></polyline>
        </svg>
      </button>
      <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--text-primary);">Discover MCP Servers</h3>
    `;
    
    if (!document.getElementById('mcp-discover-styles')) {
      const style = document.createElement('style');
      style.id = 'mcp-discover-styles';
      style.textContent = `
        .discover-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; margin-top: 16px; }
        .discover-card { display: flex; flex-direction: column; justify-content: space-between; height: 100%; border: 1px solid var(--border-color); background: var(--bg-surface); padding: 16px; border-radius: 8px; }
        .discover-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
        .discover-icon { width: 32px; height: 32px; border-radius: 4px; object-fit: contain; }
        .discover-icon-fallback { width: 32px; height: 32px; border-radius: 4px; background: var(--bg-surface-hover); display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; color: var(--text-secondary); }
        .discover-title { font-weight: 600; font-size: 15px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .discover-author { font-size: 12px; color: var(--text-tertiary); margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .discover-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 16px; flex-grow: 1; }
        .discover-actions { display: flex; justify-content: space-between; align-items: center; margin-top: auto; }
        .discover-badges { display: flex; gap: 6px; }
        .discover-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: var(--bg-surface-active); color: var(--text-secondary); text-transform: uppercase; font-weight: 600; }
        .discover-badge.keyless { background: rgba(34, 197, 94, 0.1); color: var(--color-success); border: 1px solid rgba(34, 197, 94, 0.2); }
      `;
      document.head.appendChild(style);
    }

    listContainer.appendChild(header);

    const backBtn = listContainer.querySelector('#btn-discover-back');
    if (backBtn) {
      this._trackListener(backBtn, 'click', () => {
        if (this.callbacks.onMyServersTabClick) this.callbacks.onMyServersTabClick();
      });
    }

    if (this.state.isDiscoverLoading) {
      listContainer.innerHTML += `
        <div class="skeleton-container">
          <div class="discover-grid">
            <div class="skeleton-card" style="height: 180px"></div>
            <div class="skeleton-card" style="height: 180px"></div>
            <div class="skeleton-card" style="height: 180px"></div>
            <div class="skeleton-card" style="height: 180px"></div>
          </div>
        </div>`;
      this.containerEl.appendChild(listContainer);
      return;
    }

    if (this.state.discoverError) {
      const errorDiv = document.createElement('div');
      errorDiv.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">Failed to Load Discover</div>
          <div class="modal-empty-text">${McpUtils.escapeHtml(this.state.discoverError)}</div>
          <button class="btn-secondary" id="retry-discover-btn" style="margin-top: 12px;">Retry</button>
        </div>
      `;
      listContainer.appendChild(errorDiv);
      this.containerEl.appendChild(listContainer);
      const retryBtn = listContainer.querySelector('#retry-discover-btn');
      if (retryBtn) {
        this._trackListener(retryBtn, 'click', () => {
          if (this.callbacks.onRetryDiscoverClick) this.callbacks.onRetryDiscoverClick();
        });
      }
      return;
    }

    if (this.state.discoverServers.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">No Servers Found</div>
          <div class="modal-empty-text">Could not fetch servers from the registry.</div>
        </div>
      `;
      listContainer.appendChild(emptyDiv);
      this.containerEl.appendChild(listContainer);
      return;
    }

    const filterBar = document.createElement('div');
    filterBar.className = 'modal-search-bar modal-action-bar';
    filterBar.style.marginBottom = '16px';
    filterBar.style.padding = '0';
    filterBar.style.border = 'none';
    filterBar.style.background = 'transparent';
    filterBar.innerHTML = `
      <div class="modal-search-container" style="flex: 1; margin-right: 12px;">
        <svg class="modal-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" id="discover-search-input" class="modal-search-input" placeholder="Search servers by name, author or description..." value="${McpUtils.escapeHtml(this.state.discoverSearchQuery)}">
      </div>
      <div class="modal-filter-container">
        <select id="discover-category-select" class="form-input" style="padding: 6px 12px; height: 32px; border-radius: 6px; width: auto; font-size: 13px;">
          <option value="all" ${this.state.discoverCategory === 'all' ? 'selected' : ''}>All Categories</option>
          <option value="local" ${this.state.discoverCategory === 'local' ? 'selected' : ''}>Local (NPM/PyPI/Docker)</option>
          <option value="remote" ${this.state.discoverCategory === 'remote' ? 'selected' : ''}>Remote</option>
          <option value="keyless" ${this.state.discoverCategory === 'keyless' ? 'selected' : ''}>Zero Setup</option>
        </select>
      </div>
    `;

    listContainer.appendChild(filterBar);

    const searchInput = listContainer.querySelector('#discover-search-input');
    if (searchInput) {
      this._trackListener(searchInput, 'input', (e) => {
        this.state.discoverSearchQuery = e.target.value.toLowerCase();
        this.renderDiscoverCards();
      });
    }
    const categorySelect = listContainer.querySelector('#discover-category-select');
    if (categorySelect) {
      this._trackListener(categorySelect, 'change', (e) => {
        this.state.discoverCategory = e.target.value;
        this.renderDiscoverCards();
      });
    }

    this.discoverGridEl = document.createElement('div');
    this.discoverGridEl.className = 'discover-grid';
    listContainer.appendChild(this.discoverGridEl);
    
    this.containerEl.appendChild(listContainer);
    
    this.renderDiscoverCards();
  }

  /**
   * Render cards into discover grid
   */
  renderDiscoverCards() {
    if (!this.discoverGridEl) return;
    this._clearDiscoverListeners();
    this.discoverGridEl.innerHTML = '';
    
    const filteredServers = this.state.getFilteredDiscoverServers();

    if (filteredServers.length === 0) {
      this.discoverGridEl.innerHTML = `<div class="modal-empty-state" style="grid-column: 1 / -1; margin-top: 32px;"><div class="modal-empty-title">No matches found</div><div class="modal-empty-text">Try adjusting your search or category filter.</div></div>`;
      return;
    }

    filteredServers.forEach(item => {
      const cardEl = this._createDiscoverCard(item);
      this.discoverGridEl.appendChild(cardEl);
    });
  }

  /**
   * Create discover card element
   * @private
   */
  _createDiscoverCard(item) {
    const server = item.server || {};
    const card = document.createElement('div');
    card.className = 'discover-card';
    
    const header = document.createElement('div');
    header.className = 'discover-card-header';
    
    const iconContainer = document.createElement('div');
    const iconObj = server.icons && server.icons.length > 0 ? server.icons[0] : null;
    if (iconObj && iconObj.src) {
      const img = document.createElement('img');
      img.src = McpUtils.escapeHtml(iconObj.src);
      img.className = 'discover-icon';
      img.alt = '';
      iconContainer.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'discover-icon-fallback';
      fallback.textContent = (server.title || server.name || '?').charAt(0).toUpperCase();
      iconContainer.appendChild(fallback);
    }
    
    header.appendChild(iconContainer);
    
    const info = document.createElement('div');
    info.style.flexGrow = '1';
    info.style.marginLeft = '12px';
    info.style.minWidth = '0';
    
    const title = document.createElement('div');
    title.className = 'discover-title';
    title.textContent = server.title || server.name?.split('/').pop() || 'Unknown Server';
    title.title = title.textContent;
    
    const author = document.createElement('div');
    author.className = 'discover-author';
    const authorText = server.name?.includes('/') ? server.name.split('/')[0] : '';
    author.textContent = authorText;
    author.title = authorText;
    
    info.appendChild(title);
    info.appendChild(author);
    header.appendChild(info);
    card.appendChild(header);
    
    const desc = document.createElement('div');
    desc.className = 'discover-desc';
    desc.textContent = server.description || 'No description provided.';
    desc.title = server.description || '';
    card.appendChild(desc);
    
    const actions = document.createElement('div');
    actions.className = 'discover-actions';
    
    const badges = document.createElement('div');
    badges.className = 'discover-badges';
    
    let pkgType = 'remote';
    
    if (server.packages && server.packages.length > 0) {
      const pkg = server.packages[0];
      pkgType = pkg.registryType || 'unknown'; 
      
      const badge = document.createElement('span');
      badge.className = 'discover-badge';
      badge.textContent = pkgType === 'oci' ? 'docker' : pkgType;
      badges.appendChild(badge);
    } else if (server.remotes && server.remotes.length > 0) {
      pkgType = 'remote';
      const badge = document.createElement('span');
      badge.className = 'discover-badge';
      badge.textContent = 'remote';
      badges.appendChild(badge);
    }
    
    actions.appendChild(badges);
    
    let canInstall = true;
    let missingDep = null;
    if (this.state.systemDependencies) {
      if (pkgType === 'npm' && !this.state.systemDependencies.npx) {
        canInstall = false;
        missingDep = 'Node.js (npx)';
      } else if (pkgType === 'pypi' && !this.state.systemDependencies.uvx) {
        canInstall = false;
        missingDep = 'uv (uvx)';
      } else if (pkgType === 'oci' && !this.state.systemDependencies.docker) {
        canInstall = false;
        missingDep = 'Docker';
      }
    }

    const installBtn = document.createElement('button');
    installBtn.className = 'btn-primary btn-sm';
    
    if (!canInstall && missingDep) {
      installBtn.disabled = true;
      installBtn.textContent = `Requires ${missingDep}`;
      installBtn.title = `You must install ${missingDep} to use this MCP server.`;
      installBtn.style.opacity = '0.6';
      installBtn.style.cursor = 'not-allowed';
    } else {
      installBtn.textContent = 'Install';
      this._trackDiscoverListener(installBtn, 'click', () => {
        if (this.callbacks.onInstallDiscover) this.callbacks.onInstallDiscover(server);
      });
    }
    
    actions.appendChild(installBtn);
    card.appendChild(actions);
    
    return card;
  }

  /**
   * Render registration/edit form
   */
  renderRegistrationForm() {
    const isEditing = !!this.state.editingServerId;
    const server = isEditing ? this.state.servers.find(s => (s.server_id || s.id) === this.state.editingServerId) : null;
    
    const prefill = this.state.consumeDiscoverPreFillData();
    const isFromDiscover = prefill?.isFromDiscover || false;
    
    const isNative = isEditing && server && ['slack_mcp', 'telegram_mcp', 'whatsapp_mcp', 'filesystem_mcp', 'file_indexing_mcp'].includes(server.name);
    const hideTechnical = isFromDiscover || isNative;
    
    if (prefill && this.callbacks.onPrefillPrompt) {
      this.callbacks.onPrefillPrompt();
    }

    const esc = McpUtils.escapeHtml;
    const sName = esc(isEditing ? (server?.name || '') : (prefill?.name || ''));
    const sDisplayName = esc(isEditing ? (server?.display_name || '') : (prefill?.display_name || ''));
    const sDescription = esc(isEditing ? (server?.description || '') : (prefill?.description || ''));
    const sCommand = esc(isEditing && server?.config?.command ? server.config.command : (prefill?.config?.command || ''));
    const sArgs = esc(isEditing && server?.config?.args ? (Array.isArray(server.config.args) ? server.config.args.join(' ') : server.config.args) : (prefill?.config?.args?.join(' ') || ''));
    
    let envVal = '';
    if (isEditing && server?.config?.env) {
      envVal = Object.entries(server.config.env).map(([k, v]) => `${k}=${v}`).join('\n');
      if (isNative && !envVal) {
        if (server.name === 'slack_mcp') envVal = 'SLACK_BOT_TOKEN=YOUR_TOKEN_HERE';
        if (server.name === 'telegram_mcp') envVal = 'TELEGRAM_API_ID=YOUR_API_ID_HERE\nTELEGRAM_API_HASH=YOUR_API_HASH_HERE';
      }
    } else if (prefill?.config?.env) {
      envVal = Object.entries(prefill.config.env).map(([k, v]) => `${k}=YOUR_${k}_HERE`).join('\n');
    }
    const sEnv = esc(envVal);
    
    const sUrl = esc(isEditing && server?.config?.url ? server.config.url : (prefill?.config?.url || ''));
    const sApiKey = esc(isEditing && server?.config?.api_key ? server.config.api_key : '');
    const sMaxMemory = isEditing && server?.resource_limits?.max_memory_mb ? String(server.resource_limits.max_memory_mb) : '';
    const sMaxCpu = isEditing && server?.resource_limits?.max_cpu_percent ? String(server.resource_limits.max_cpu_percent) : '';
    const sMaxTime = isEditing && server?.resource_limits?.max_execution_time_seconds ? String(server.resource_limits.max_execution_time_seconds) : '';

    const isRemote = (isEditing && server?.server_type === 'remote') || (prefill?.server_type === 'remote');

    const formContainer = document.createElement('div');
    formContainer.className = 'mcp-registration-form';
    formContainer.innerHTML = `
      <div class="form-section">
        <h3 class="form-section-title">Basic Information</h3>
        <div class="form-group" style="display: ${hideTechnical ? 'none' : 'block'};">
          <label for="mcp-name">Name *</label>
          <input type="text" id="mcp-name" class="form-input" placeholder="e.g., filesystem_tools" value="${sName}" ${isEditing ? 'disabled' : ''}>
          <small>Internal identifier (lowercase, no spaces)</small>
        </div>
        <div class="form-group">
          <label for="mcp-display-name">Display Name</label>
          <input type="text" id="mcp-display-name" class="form-input" placeholder="e.g., Filesystem Tools" value="${sDisplayName}">
        </div>
        <div class="form-group">
          <label for="mcp-description">Description</label>
          <textarea id="mcp-description" class="form-input" placeholder="Brief description of this server" rows="2">${sDescription}</textarea>
        </div>
        <div class="form-group" style="display: ${hideTechnical ? 'none' : 'block'};">
          <label>Server Type *</label>
          <div class="form-radio-group">
            <label class="form-radio">
              <input type="radio" name="server-type" value="local" ${!isRemote ? 'checked' : ''}>
              <span>Local</span>
            </label>
            <label class="form-radio">
              <input type="radio" name="server-type" value="remote" ${isRemote ? 'checked' : ''}>
              <span>Remote</span>
            </label>
          </div>
        </div>
      </div>

      <div class="form-section" id="local-config" style="display: ${isRemote ? 'none' : 'block'};">
        <h3 class="form-section-title">${hideTechnical ? 'Required Credentials & Setup' : 'Local Configuration'}</h3>
        <div class="form-group" style="display: ${hideTechnical ? 'none' : 'block'};">
          <label for="mcp-command">Command *</label>
          <input type="text" id="mcp-command" class="form-input" placeholder="e.g., node" value="${sCommand}">
        </div>
        <div class="form-group" style="display: ${hideTechnical ? 'none' : 'block'};">
          <label for="mcp-args">Arguments</label>
          <input type="text" id="mcp-args" class="form-input" placeholder="e.g., /path/to/server.js" value="${sArgs}">
          <small>Space-separated arguments</small>
        </div>
        <div class="form-group">
          <label for="mcp-env">Environment Variables ${hideTechnical ? '(Required)' : ''}</label>
          ${hideTechnical && sEnv ? `<p style="font-size: 13px; color: var(--text-secondary); margin-top: -4px; margin-bottom: 8px;">Please provide the following required credentials to connect this service. Replace 'YOUR_KEY_HERE' with your actual values.</p>` : ''}
          ${hideTechnical && !sEnv ? `<p style="font-size: 13px; color: var(--text-secondary); margin-top: -4px; margin-bottom: 8px;">No extra configuration required, click 'Register & Start' below.</p>` : ''}
          <textarea id="mcp-env" class="form-input" placeholder="KEY1=value1&#10;KEY2=value2" rows="${hideTechnical ? '5' : '3'}" ${hideTechnical && !sEnv ? 'style="display:none;"' : ''}>${sEnv}</textarea>
          <small ${hideTechnical && !sEnv ? 'style="display:none;"' : ''}>One per line: KEY=value</small>
        </div>
      </div>

      <div class="form-section" id="remote-config" style="display: ${isRemote ? 'block' : 'none'};">
        <h3 class="form-section-title">Remote Configuration</h3>
        <div class="form-group">
          <label for="mcp-url">Server URL *</label>
          <input type="text" id="mcp-url" class="form-input" placeholder="https://example.com/mcp" value="${sUrl}">
        </div>
        <div class="form-group">
          <label for="mcp-api-key">API Key</label>
          <input type="password" id="mcp-api-key" class="form-input" placeholder="Optional authentication key" value="${sApiKey}">
        </div>
      </div>

      <div class="form-section">
        <h3 class="form-section-title">Advanced Settings</h3>
        <div class="form-group">
          <label class="aether-switch">
            <input type="checkbox" id="mcp-sandbox" ${(!isEditing) || (isEditing && server?.sandbox_enabled !== false) ? 'checked' : ''}>
            <span class="aether-switch-track"><span class="aether-switch-thumb"></span></span>
            <span>Enable Sandbox</span>
          </label>
          <small style="display: block; margin-top: 4px;">Run server in isolated environment</small>
        </div>
        <div class="form-group">
          <label class="aether-switch">
            <input type="checkbox" id="mcp-auto-start" ${isEditing && server?.auto_start ? 'checked' : ''}>
            <span class="aether-switch-track"><span class="aether-switch-thumb"></span></span>
            <span>Auto-start on application launch</span>
          </label>
        </div>
        <div class="form-group">
          <label class="aether-switch">
            <input type="checkbox" id="mcp-enabled" ${!isEditing || server?.enabled ? 'checked' : ''}>
            <span class="aether-switch-track"><span class="aether-switch-thumb"></span></span>
            <span>Enabled</span>
          </label>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="mcp-max-memory">Max Memory (MB)</label>
            <input type="number" id="mcp-max-memory" class="form-input" placeholder="512" value="${sMaxMemory}">
          </div>
          <div class="form-group">
            <label for="mcp-max-cpu">Max CPU %</label>
            <input type="number" id="mcp-max-cpu" class="form-input" placeholder="80" min="1" max="100" value="${sMaxCpu}">
          </div>
          <div class="form-group">
            <label for="mcp-max-time">Max Execution Time (s)</label>
            <input type="number" id="mcp-max-time" class="form-input" placeholder="300" value="${sMaxTime}">
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn-secondary" id="cancel-btn">Cancel</button>
        <button class="btn-primary" id="submit-btn">${isEditing ? 'Update Server' : 'Register & Start'}</button>
      </div>
    `;
    
    this.containerEl.appendChild(formContainer);
    this._setupFormListeners();
  }

  /**
   * Setup form event listeners
   * @private
   */
  _setupFormListeners() {
    const q = (sel) => this.containerEl.querySelector(sel);
    const localConfig = q('#local-config');
    const remoteConfig = q('#remote-config');
    const radioButtons = this.containerEl.querySelectorAll('input[name="server-type"]');
    
    radioButtons.forEach(radio => {
      this._trackListener(radio, 'change', (e) => {
        if (e.target.value === 'local') {
          if (localConfig) localConfig.style.display = 'block';
          if (remoteConfig) remoteConfig.style.display = 'none';
        } else {
          if (localConfig) localConfig.style.display = 'none';
          if (remoteConfig) remoteConfig.style.display = 'block';
        }
      });
    });
    
    const cancelBtn = q('#cancel-btn');
    if (cancelBtn) {
      this._trackListener(cancelBtn, 'click', () => {
        if (this.callbacks.onCancelForm) this.callbacks.onCancelForm();
      });
    }
    
    const submitBtn = q('#submit-btn');
    if (submitBtn) {
      this._trackListener(submitBtn, 'click', () => {
        if (this.callbacks.onSubmitForm) this.callbacks.onSubmitForm();
      });
    }
  }

  /**
   * Show tools modal
   */
  renderToolsModal(serverName, tools) {
    this._clearToolsListeners();
    const esc = McpUtils.escapeHtml;
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay is-visible';
    modal.innerHTML = `
      <div class="modal-panel modal-panel--md modal-panel--auto">
        <div class="modal-header">
          <h2 class="modal-title">Tools: ${esc(serverName)}</h2>
          <button class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          ${tools.length === 0 ? '<div class="modal-empty-state"><p>No tools available</p></div>' : `
          <div class="tools-list">
            ${tools.map(tool => `
              <div class="tool-item">
                <div class="tool-name">${esc(tool.name)}</div>
                <div class="tool-description">${esc(tool.description || 'No description')}</div>
              </div>
            `).join('')}
          </div>
          `}
        </div>
        <div class="modal-footer">
          <button class="btn-primary" id="close-tools-modal">Close</button>
        </div>
      </div>
    `;
    
    if (this._subModalEl && this._subModalEl.parentNode) {
      this._subModalEl.parentNode.removeChild(this._subModalEl);
    }
    this._subModalEl = modal;
    document.body.appendChild(modal);
    
    const closeBtn = modal.querySelector('.modal-close');
    const closeFooterBtn = modal.querySelector('#close-tools-modal');
    const closeModal = () => {
      modal.classList.remove('is-visible');
      const timerId = setTimeout(() => {
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        if (this._subModalEl === modal) this._subModalEl = null;
        this._clearToolsListeners();
      }, 300);
      this._timers.push(timerId);
    };
    
    this._trackToolsListener(closeBtn, 'click', closeModal);
    this._trackToolsListener(closeFooterBtn, 'click', closeModal);
    this._trackToolsListener(modal, 'click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  /**
   * Parse form DOM into a state object
   * Note: Returning early if invalid, but caller handles Toasts.
   * To keep it simple, it returns { valid: boolean, data: obj, errorMsg: string }
   */
  collectFormData(isEditing) {
    const q = (sel) => this.containerEl.querySelector(sel);
    const nameEl = q('#mcp-name');
    const displayNameEl = q('#mcp-display-name');
    const descriptionEl = q('#mcp-description');
    const serverTypeEl = q('input[name="server-type"]:checked');
    const sandboxEl = q('#mcp-sandbox');
    const autoStartEl = q('#mcp-auto-start');
    const enabledEl = q('#mcp-enabled');
    
    if (!nameEl || !displayNameEl || !descriptionEl || !serverTypeEl) return { valid: false };

    const name = nameEl.value.trim();
    const displayName = displayNameEl.value.trim();
    const description = descriptionEl.value.trim();
    const serverType = serverTypeEl.value;
    const sandbox = sandboxEl?.checked || false;
    const autoStart = autoStartEl?.checked || false;
    const enabled = enabledEl?.checked || false;
    
    if (!isEditing && !name) {
      return { valid: false, errorMsg: 'Server name is required.' };
    }
    
    let config = {};
    
    const maxMemoryEl = q('#mcp-max-memory');
    const maxCpuEl = q('#mcp-max-cpu');
    const maxTimeEl = q('#mcp-max-time');
    
    const maxMemory = maxMemoryEl?.value;
    const maxCpu = maxCpuEl?.value;
    const maxTime = maxTimeEl?.value;
    
    let resource_limits = null;
    if (maxMemory || maxCpu || maxTime) {
      resource_limits = {};
      if (maxMemory) resource_limits.max_memory_mb = parseInt(maxMemory);
      if (maxCpu) resource_limits.max_cpu_percent = parseInt(maxCpu);
      if (maxTime) resource_limits.max_execution_time_seconds = parseInt(maxTime);
    }
    
    if (serverType === 'local') {
      const commandEl = q('#mcp-command');
      const argsEl = q('#mcp-args');
      const envTextEl = q('#mcp-env');
      
      const command = commandEl ? commandEl.value.trim() : '';
      const args = argsEl ? argsEl.value.trim() : '';
      const envText = envTextEl ? envTextEl.value.trim() : '';
      
      if (!command) {
        return { valid: false, errorMsg: 'Command is required for local servers.' };
      }
      
      config.command = command;
      if (args) {
        config.args = args.split(/\s+/);
      }
      
      if (envText) {
        const env = {};
        envText.split('\n').forEach(line => {
          const [key, ...valueParts] = line.split('=');
          if (key && valueParts.length > 0) {
            env[key.trim()] = valueParts.join('=').trim();
          }
        });
        config.env = env;
      }
    } else {
      const urlEl = q('#mcp-url');
      const apiKeyEl = q('#mcp-api-key');
      
      const url = urlEl ? urlEl.value.trim() : '';
      const apiKey = apiKeyEl ? apiKeyEl.value.trim() : '';
      
      if (!url) {
        return { valid: false, errorMsg: 'Server URL is required for remote servers.' };
      }
      
      config.url = url;
      if (apiKey) {
        config.api_key = apiKey;
      }
    }
    
    return {
      valid: true,
      data: {
        name: name || undefined,
        display_name: displayName || name,
        description: description || undefined,
        server_type: serverType,
        config,
        auto_start: autoStart,
        enabled,
        sandbox_enabled: sandbox,
        resource_limits: resource_limits
      }
    };
  }

  // --- Lifecycle Tracking ---

  _trackListener(element, event, handler, options) {
    if (!element || !event || !handler) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  _trackDiscoverListener(element, event, handler, options) {
    if (!element || !event || !handler) return;
    element.addEventListener(event, handler, options);
    this._discoverListeners.push({ element, event, handler, options });
  }

  _trackToolsListener(element, event, handler, options) {
    if (!element || !event || !handler) return;
    element.addEventListener(event, handler, options);
    this._toolsListeners.push({ element, event, handler, options });
  }

  _clearMainListeners() {
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];
    this._clearDiscoverListeners();
  }

  _clearDiscoverListeners() {
    for (const { element, event, handler, options } of this._discoverListeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._discoverListeners = [];
  }

  _clearToolsListeners() {
    for (const { element, event, handler, options } of this._toolsListeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._toolsListeners = [];
  }

  _clearTimers() {
    for (const id of this._timers) {
      clearTimeout(id);
    }
    this._timers = [];
  }

  _clearListeners() {
    this._clearMainListeners();
    this._clearToolsListeners();
    this._clearTimers();
  }

  dispose() {
    this._clearListeners();
    if (this._subModalEl && this._subModalEl.parentNode) {
      this._subModalEl.parentNode.removeChild(this._subModalEl);
    }
    this._subModalEl = null;
    this.containerEl.innerHTML = '';
  }
}

module.exports = McpRenderers;
