'use strict';

/**
 * @.architecture
 * Incoming: MainApp (user opens modal), Endpoint (HTTP API) --- {user_click, api_response}
 * Processing: Display artifacts library with date grouping, type filtering, CRUD operations --- {JOB_RENDER, JOB_QUERY_DB, JOB_DELETE, JOB_UPDATE, JOB_EXPORT}
 * Outgoing: Artifacts window (open selected artifact), Endpoint (API calls) --- {artifact_open_event, http_request}
 * 
 * @module renderer/main/modules/artifacts-library/ArtifactsLibraryModal
 */

const BaseModal = require('../../../shared/modals/BaseModal');
const Toast = require('../../../shared/components/Toast');
const ConfirmDialog = require('../../../shared/components/ConfirmDialog');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const { createRendererLogger } = require('../../../shared/utils/logger');

/**
 * Artifacts Library Modal
 * 
 * Displays all user artifacts grouped by date with options to:
 * - Search/filter artifacts
 * - Filter by type
 * - Export artifacts
 * - Edit artifacts
 * - Delete artifacts
 * - View/open artifacts
 * - Navigate to parent chat
 */
class ArtifactsLibraryModal extends BaseModal {
  constructor(options = {}) {
    // Extract non-serializable objects before passing to super
    const { eventBus, endpoint, artifactsWindow, ...baseOptions } = options;
    
    super({
      ...baseOptions,
      id: 'artifacts-library-modal',
      title: 'Artifacts Library',
      size: 'xl',
      heightPreset: 'default'
    });
    
    const aether = getAether();
    this.endpoint = endpoint || aether?.endpoint || null;
    this.artifactsWindow = artifactsWindow || null;
    this.eventBus = eventBus || null;
    
    // State
    this.artifacts = [];
    this.filteredArtifacts = [];
    this.searchQuery = '';
    this.selectedType = 'all';

    // Lifecycle tracking
    this._listeners = [];
    this._openSequence = 0;
    
    this.log = createRendererLogger('ArtifactsLibraryModal');
    
    // Type icons mapping - using SVG document icon
    this.typeIcons = {
      'html': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'css': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'javascript': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'python': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'java': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'typescript': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'json': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'xml': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'markdown': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'text': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>',
      'image': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
      'default': '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>'
    };
    
    // Bind methods
    this._handleSearch = this._handleSearch.bind(this);
    this._handleTypeFilter = this._handleTypeFilter.bind(this);
  }

  /**
   * Render modal content
   * @private
   */
  async _renderContent() {
    if (!this.endpoint) {
      this.bodyEl.innerHTML = '<div class="modal-empty-state"><p>Endpoint not initialized</p></div>';
      return;
    }
    
    // Show skeleton loading state
    this.bodyEl.innerHTML = `
      <div class="skeleton-container">
        <div class="skeleton-row"><div class="skeleton-line skeleton-line--md skeleton-line--thick"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--lg" style="flex:1"></div></div><div class="skeleton-line skeleton-line--full"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--md" style="flex:1"></div></div><div class="skeleton-line skeleton-line--full"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--lg" style="flex:1"></div></div><div class="skeleton-line skeleton-line--lg"></div></div>
      </div>`;
    
    const seq = ++this._openSequence;
    try {
      this.artifacts = await this.endpoint.listAllArtifacts(50);
      if (seq !== this._openSequence) return;
      this.filteredArtifacts = [...this.artifacts];
      
      this._renderUI();
    } catch (error) {
      if (seq !== this._openSequence) return;
      this.log.error('[ArtifactsLibraryModal] Failed to load artifacts:', error);
      this.bodyEl.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">Failed to Load Artifacts</div>
          <div class="modal-empty-text">${error.message || 'Unknown error'}</div>
        </div>
      `;
    }
  }

  /**
   * Render modal UI
   * @private
   */
  _renderUI() {
    // ARCHITECTURAL FIX: Use normalized artifact types, not language
    // Normalize artifact types to categories: code, output, attachment
    const normalizedTypes = this.artifacts.map(a => this._getNormalizedType(a));
    const uniqueTypes = [...new Set(normalizedTypes)];
    
    // Define filter options with proper labels
    const typeOptions = [
      { value: 'all', label: 'All Types' },
      ...uniqueTypes.sort().map(type => ({
        value: type,
        label: type.charAt(0).toUpperCase() + type.slice(1)
      }))
    ];
    
    // Create search bar and type filter
    const searchBar = document.createElement('div');
    searchBar.className = 'modal-search-bar';
    searchBar.innerHTML = `
      <div class="modal-search-wrapper">
        <svg class="modal-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
        </svg>
        <input type="text" class="modal-search-input" placeholder="Search artifacts..." id="artifact-search-input">
      </div>
      <div class="modal-filter-wrapper">
        <label for="artifact-type-filter" class="modal-filter-label">Type:</label>
        <select id="artifact-type-filter" class="modal-filter-select">
          ${typeOptions.map(opt => `<option value="${opt.value}">${opt.label}</option>`).join('')}
        </select>
      </div>
    `;
    
    const searchInput = searchBar.querySelector('#artifact-search-input');
    this._trackListener(searchInput, 'input', this._handleSearch);
    
    const typeFilter = searchBar.querySelector('#artifact-type-filter');
    this._trackListener(typeFilter, 'change', this._handleTypeFilter);
    
    this._clearListenersForElement(this.bodyEl);
    while (this.bodyEl.firstChild) {
      this.bodyEl.removeChild(this.bodyEl.firstChild);
    }
    this.bodyEl.appendChild(searchBar);
    
    // Render artifact list
    this._renderArtifactList();
  }

  /**
   * Render artifact list grouped by date
   * @private
   */
  _renderArtifactList() {
    const listContainer = document.createElement('div');
    
    if (this.filteredArtifacts.length === 0) {
      listContainer.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">No Artifacts Found</div>
          <div class="modal-empty-text">${this.searchQuery || this.selectedType !== 'all' ? 'Try adjusting your filters' : 'No artifacts have been created yet'}</div>
        </div>
      `;
    const existingList = this.bodyEl.querySelector('.artifact-list-container');
    if (existingList) {
      this._clearListenersForElement(existingList);
      existingList.replaceWith(listContainer);
    } else {
      listContainer.className = 'artifact-list-container';
      this.bodyEl.appendChild(listContainer);
    }
    return;
    }
    
    // Group artifacts by date
    const groups = this._groupArtifactsByDate(this.filteredArtifacts);
    
    // Render each group
    for (const [groupName, artifacts] of Object.entries(groups)) {
      const groupEl = document.createElement('div');
      groupEl.className = 'date-group';
      
      const headerEl = document.createElement('div');
      headerEl.className = 'date-group-header';
      headerEl.textContent = groupName;
      groupEl.appendChild(headerEl);
      
      const contentEl = document.createElement('div');
      contentEl.className = 'date-group-content';
      
      artifacts.forEach(artifact => {
        const cardEl = this._createArtifactCard(artifact);
        contentEl.appendChild(cardEl);
      });
      
      groupEl.appendChild(contentEl);
      listContainer.appendChild(groupEl);
    }
    
    const existingList = this.bodyEl.querySelector('.artifact-list-container');
    if (existingList) {
      this._clearListenersForElement(existingList);
      existingList.replaceWith(listContainer);
    } else {
      listContainer.className = 'artifact-list-container';
      this.bodyEl.appendChild(listContainer);
    }
  }

  /**
   * Create artifact card element
   * @private
   */
  _createArtifactCard(artifact) {
    const card = document.createElement('div');
    card.className = 'modal-card artifact-card';
    card.dataset.artifactId = artifact.id;
    
    const header = document.createElement('div');
    header.className = 'modal-card-header';
    
    const titleRow = document.createElement('div');
    titleRow.className = 'modal-card-title-row';
    
    const icon = document.createElement('span');
    icon.className = 'artifact-icon';
    const type = (artifact.language || 'text').toLowerCase();
    icon.innerHTML = this.typeIcons[type] || this.typeIcons['default'];
    
    const title = document.createElement('div');
    title.className = 'modal-card-title';
    title.textContent = artifact.filename || 'Untitled Artifact';
    
    titleRow.appendChild(icon);
    titleRow.appendChild(title);
    
    const actions = document.createElement('div');
    actions.className = 'modal-card-actions';
    
    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'modal-action-btn';
    exportBtn.title = 'Export';
    exportBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
    this._trackListener(exportBtn, 'click', (e) => {
      e.stopPropagation();
      this._handleExport(artifact.id, artifact.filename);
    });
    
    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'modal-action-btn';
    editBtn.title = 'Edit';
    editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
    this._trackListener(editBtn, 'click', (e) => {
      e.stopPropagation();
      this._handleEdit(artifact.id);
    });
    
    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'modal-action-btn danger';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
    this._trackListener(deleteBtn, 'click', (e) => {
      e.stopPropagation();
      this._handleDelete(artifact.id, artifact.filename);
    });
    
    // View button
    const viewBtn = document.createElement('button');
    viewBtn.className = 'modal-action-btn primary';
    viewBtn.title = 'View';
    viewBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    this._trackListener(viewBtn, 'click', (e) => {
      e.stopPropagation();
      this._handleView(artifact.id);
    });
    
    actions.appendChild(exportBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    actions.appendChild(viewBtn);
    
    header.appendChild(titleRow);
    header.appendChild(actions);
    
    // Chat source -- SAFE: user data set via textContent/dataset, not interpolated into HTML
    const chatSource = document.createElement('div');
    chatSource.className = 'modal-card-source';
    chatSource.appendChild(document.createTextNode('From: '));
    const chatLink = document.createElement('span');
    chatLink.className = 'chat-link';
    chatLink.dataset.chatId = artifact.chat_id || '';
    chatLink.textContent = artifact.chat_title || 'Unknown Chat';
    this._trackListener(chatLink, 'click', (e) => {
      e.stopPropagation();
      this._handleOpenChat(artifact.chat_id);
    });
    chatSource.appendChild(chatLink);
    
    const meta = document.createElement('div');
    meta.className = 'modal-card-meta';
    const date = this._formatDate(artifact.created_at);
    const size = artifact.content ? `${(artifact.content.length / 1024).toFixed(1)} KB` : 'Unknown size';
    meta.textContent = `${date} • ${size}`;
    
    card.appendChild(header);
    card.appendChild(chatSource);
    card.appendChild(meta);
    
    // Click to view
    this._trackListener(card, 'click', () => this._handleView(artifact.id));
    
    return card;
  }

  /**
   * Group artifacts by date
   * @private
   */
  _groupArtifactsByDate(artifacts) {
    const groups = {
      'Today': [],
      'Yesterday': [],
      'This Week': [],
      'This Month': [],
      'Older': []
    };
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    
    artifacts.forEach(artifact => {
      const artifactDate = new Date(artifact.created_at);
      
      if (artifactDate >= today) {
        groups['Today'].push(artifact);
      } else if (artifactDate >= yesterday) {
        groups['Yesterday'].push(artifact);
      } else if (artifactDate >= weekAgo) {
        groups['This Week'].push(artifact);
      } else if (artifactDate >= monthAgo) {
        groups['This Month'].push(artifact);
      } else {
        groups['Older'].push(artifact);
      }
    });
    
    // Remove empty groups
    Object.keys(groups).forEach(key => {
      if (groups[key].length === 0) {
        delete groups[key];
      }
    });
    
    return groups;
  }

  /**
   * Format date for display
   * @private
   */
  _formatDate(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    if (date >= today) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } else if (date >= new Date(today.getTime() - 86400000)) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }

  /**
   * Handle search input
   * @private
   */
  _handleSearch(e) {
    this.searchQuery = e.target.value.toLowerCase();
    this._applyFilters();
  }

  /**
   * Handle type filter change
   * @private
   */
  _handleTypeFilter(e) {
    this.selectedType = e.target.value;
    this._applyFilters();
  }

  /**
   * Get normalized artifact type category
   * Maps raw artifact types to: code, output, or attachment
   * @private
   */
  _getNormalizedType(artifact) {
    const type = artifact.type || '';
    const role = artifact.role || (artifact.metadata && artifact.metadata.role) || '';
    
    // Per architecture: assistant:code → 'code'
    if (role === 'assistant' && type === 'code') {
      return 'code';
    }
    
    // Per architecture: computer:output → 'output' (includes html, console, text, etc.)
    if (role === 'computer' && type === 'output') {
      return 'output';
    }
    
    // Legacy types that should be normalized to output
    if (['html', 'console', 'markdown', 'json', 'text'].includes(type)) {
      return 'output';
    }
    
    // Per architecture: type:file → 'attachment'
    if (type === 'file') {
      return 'attachment';
    }
    
    // Default: categorize by type if it's code-related
    if (type === 'code') {
      return 'code';
    }
    
    // Default to output for unknown types
    return 'output';
  }

  /**
   * Apply search and type filters
   * @private
   */
  _applyFilters() {
    this.filteredArtifacts = this.artifacts.filter(artifact => {
      // Search filter
      const matchesSearch = this.searchQuery === '' ||
        (artifact.filename || '').toLowerCase().includes(this.searchQuery) ||
        (artifact.chat_title || '').toLowerCase().includes(this.searchQuery);
      
      // Type filter - use normalized types
      const artifactType = this._getNormalizedType(artifact);
      const matchesType = this.selectedType === 'all' || artifactType === this.selectedType;
      
      return matchesSearch && matchesType;
    });
    
    this._renderArtifactList();
  }

  /**
   * Handle artifact export
   * @private
   */
  async _handleExport(artifactId, filename) {
    try {
      // Use the export endpoint which returns a downloadable file
      const response = await this.endpoint.exportArtifact(artifactId);
      
      // Create download link
      const blob = new Blob([response.data || response], { type: 'application/octet-stream' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'artifact.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      this.log.error('[ArtifactsLibraryModal] Failed to export artifact:', error);
      Toast.error('Failed to export artifact. Please try again.');
    }
  }

  /**
   * Handle artifact edit
   * @private
   */
  async _handleEdit(artifactId) {
    // ARCHITECTURAL FIX: Don't switch windows, emit event for parent to handle
    if (this.eventBus) {
      this.eventBus.emit('modal:artifact-edit-requested', { artifactId });
    }
    // Keep modal open so user sees what happens
  }

  /**
   * Handle artifact delete
   * @private
   */
  async _handleDelete(artifactId, filename) {
    const confirmed = await ConfirmDialog.confirm({
      title: 'Delete artifact',
      message: `Delete artifact "${filename}"? This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger'
    });
    
    if (confirmed) {
      try {
        await this.endpoint.deleteArtifact(artifactId);
        
        // Remove from memory
        this.artifacts = this.artifacts.filter(a => a.id !== artifactId);
        this.filteredArtifacts = this.filteredArtifacts.filter(a => a.id !== artifactId);
        
        // Re-render
        this._renderArtifactList();
        
        // Show deletion feedback (use info, not success, for destructive actions)
        Toast.info(`Deleted "${filename || 'Artifact'}"`);
      } catch (error) {
        this.log.error('[ArtifactsLibraryModal] Failed to delete artifact:', error);
        Toast.error('Failed to delete artifact. Please try again.');
      }
    }
  }

  /**
   * Handle artifact view
   * @private
   */
  _handleView(artifactId) {
    // ARCHITECTURAL FIX: Don't switch windows, emit event for parent to handle
    if (this.eventBus) {
      this.eventBus.emit('modal:artifact-view-requested', { artifactId });
    }
    // Keep modal open so user sees what happens
  }

  /**
   * Handle open parent chat
   * @private
   */
  _handleOpenChat(chatId) {
    // ARCHITECTURAL FIX: Don't switch windows, emit event for parent to handle
    if (this.eventBus) {
      this.eventBus.emit('modal:chat-open-requested', { chatId });
    }
    // Keep modal open so user sees what happens
  }

  /**
   * Cleanup
   * @private
   */
  _cleanup() {
    this._openSequence++;
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];

    this.artifacts = [];
    this.filteredArtifacts = [];
    this.searchQuery = '';
    this.selectedType = 'all';
  }

  /** @private */
  _clearListenersForElement(targetElement) {
    if (!targetElement) return;
    const remaining = [];
    for (const listener of this._listeners) {
      if (listener.element && (listener.element === targetElement || targetElement.contains(listener.element))) {
        listener.element.removeEventListener(listener.event, listener.handler, listener.options);
      } else {
        remaining.push(listener);
      }
    }
    this._listeners = remaining;
  }

  /** @private */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }
}

module.exports = ArtifactsLibraryModal;
