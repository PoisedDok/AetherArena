'use strict';

/**
 * @.architecture
 * 
 * Incoming: Context menu (View Files), storage bridge getArtifacts --- {user_click, ipc_response}
 * Processing: Display all chat files/artifacts as floating centered modal with click-to-open --- {4 jobs: JOB_CREATE_DOM_ELEMENT, JOB_HTTP_REQUEST, JOB_RENDER, JOB_EMIT_EVENT}
 * Outgoing: Floating modal overlay, EventBus (artifacts:open-file) --- {HTMLElement, event.custom}
 * 
 * @module renderer/chat/modals/ChatFilesModal
 */

const BaseModal = require('../../shared/modals/BaseModal');
const { createRendererLogger } = require('../../shared/utils/logger');
const { EventTypes } = require('../../../core/events/EventTypes');
const Toast = require('../../shared/components/Toast');
const ConfirmDialog = require('../../shared/components/ConfirmDialog');
const { getAether } = require('../../shared/bridge/AetherBridge');

class ChatFilesModal extends BaseModal {
  constructor(options = {}) {
    super({
      ...options,
      id: 'chat-files-modal',
      title: 'Chat Files'
    });
    
    this.log = createRendererLogger('ChatFilesModal');
    this.eventBus = options.eventBus;
    this.chatId = null;
    this.artifacts = [];
    this.aether = options.aether || getAether();
    this.endpoint = options.endpoint || null;

    // Lifecycle tracking
    this._listeners = [];
    this._requestSequence = 0;
  }

  async open(chatId) {
    if (!chatId) {
      this.log.warn('No chatId provided');
      return;
    }
    this.chatId = chatId;
    await super.open();
  }

  async _renderContent() {
    this._clearTrackedListeners();

    const title = document.createElement('h3');
    title.textContent = 'Chat Files';
    title.className = 'cm-section-title';

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.className = 'cm-action-btn cm-action-btn--close';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    this._trackListener(closeBtn, 'click', () => this.close());

    this.headerEl.innerHTML = '';
    this.headerEl.appendChild(title);
    this.headerEl.appendChild(closeBtn);

    this.bodyEl.innerHTML = `
      <div class="skeleton-container">
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--lg" style="flex:1"></div></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--md" style="flex:1"></div></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-line skeleton-line--lg" style="flex:1"></div></div><div class="skeleton-line skeleton-line--lg"></div></div>
      </div>`;

    this._loadArtifactData();
  }

  /** @private */
  async _loadArtifactData() {
    const seq = ++this._requestSequence;
    try {
      const artifacts = await this.aether?.storage?.loadArtifacts(this.chatId);
      if (seq !== this._requestSequence || !this.isOpen) return;

      this.artifacts = Array.isArray(artifacts) ? artifacts : [];

      if (this.artifacts.length > 0) {
        this._displayArtifacts(this.artifacts);
      } else {
        this._displayEmpty();
      }
    } catch (error) {
      if (seq !== this._requestSequence || !this.isOpen) return;
      this.log.error('failed to load artifacts', { error, chatId: this.chatId });
      this._displayError();
    }
  }

  _displayArtifacts(artifacts) {
    this._clearBodyListeners();
    while (this.bodyEl.firstChild) {
      this.bodyEl.removeChild(this.bodyEl.firstChild);
    }
    
    // Group artifacts by category - EXCLUDE code files (only show attachments and outputs)
    const categories = {
      attachments: artifacts.filter(a => a.type === 'file'),
      outputs: artifacts.filter(a => ['output', 'console', 'html', 'text', 'markdown', 'json'].includes(a.type))
    };
    
    // Render each category
    if (categories.attachments.length > 0) {
      this._renderCategory('Attachments', categories.attachments, '');
    }
    if (categories.outputs.length > 0) {
      this._renderCategory('Outputs', categories.outputs, '');
    }
    
    // If no categorized files
    if (categories.attachments.length === 0 && categories.outputs.length === 0) {
      this._displayEmpty();
    }
  }

  _renderCategory(title, artifacts, icon) {
    const section = document.createElement('div');
    section.className = 'cfm-section';
    
    const header = document.createElement('h4');
    header.textContent = icon ? `${icon} ${title} (${artifacts.length})` : `${title} (${artifacts.length})`;
    header.className = 'cfm-category-header';
    section.appendChild(header);
    
    const list = document.createElement('div');
    list.className = 'cfm-list';
    
    artifacts.forEach(artifact => {
      const item = this._createArtifactItem(artifact);
      list.appendChild(item);
    });
    
    section.appendChild(list);
    this.bodyEl.appendChild(section);
  }

  _createArtifactItem(artifact) {
    const item = document.createElement('div');
    item.className = 'cfm-item';
    
    // Filename row
    const filenameRow = document.createElement('div');
    filenameRow.className = 'cfm-filename-row';
    
    const filename = document.createElement('span');
    // CRITICAL FIX: API returns 'title', not 'filename'
    const displayName = artifact.title || artifact.filename || `${artifact.type}.${artifact.language || 'txt'}`;
    filename.textContent = displayName;
    filename.className = 'cfm-filename';
    
    const rightActions = document.createElement('div');
    rightActions.className = 'cfm-right-actions';
    
    const size = document.createElement('span');
    const sizeText = this._formatSize(artifact.content?.length || 0);
    size.textContent = sizeText;
    size.className = 'cfm-size';
    
    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'cfm-delete-btn';
    deleteBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
    `;
    deleteBtn.title = 'Delete artifact';
    deleteBtn.setAttribute('aria-label', 'Delete artifact');
    
    this._trackListener(deleteBtn, 'click', async (e) => {
      e.stopPropagation(); // Prevent opening artifact
      await this._handleDeleteArtifact(artifact);
    });
    
    rightActions.appendChild(size);
    rightActions.appendChild(deleteBtn);
    
    filenameRow.appendChild(filename);
    filenameRow.appendChild(rightActions);
    item.appendChild(filenameRow);
    
    // Metadata row
    const metaRow = document.createElement('div');
    metaRow.className = 'cfm-meta-row';
    
    const typeTag = document.createElement('span');
    typeTag.textContent = artifact.type;
    typeTag.className = 'cfm-type-tag';
    
    const timestamp = document.createElement('span');
    timestamp.textContent = this._formatTimestamp(artifact.created_at);
    
    metaRow.appendChild(typeTag);
    if (artifact.language) {
      const lang = document.createElement('span');
      lang.textContent = artifact.language;
      metaRow.appendChild(lang);
    }
    metaRow.appendChild(timestamp);
    item.appendChild(metaRow);
    
    // Click handler - emit event to open in artifacts window
    this._trackListener(item, 'click', () => {
      this._openArtifact(artifact);
    });
    
    return item;
  }

  _openArtifact(artifact) {
    const artifactId = artifact.id || artifact.artifact_id;
    const displayName = artifact.title || artifact.filename;
    this.log.info('opening artifact', { artifactId, filename: displayName, type: artifact.type });
    
    // For file type artifacts (user attachments), open in FileViewerModal
    if (artifact.type === 'file') {
      // Close this modal first
      this.close();
      
      // Emit event to open FileViewerModal (same as clicking attachment in chat)
      if (this.eventBus) {
        this.eventBus.emit('artifacts:open-file', {
          artifactId: artifactId,
          filename: displayName,
          content: artifact.content,
          type: artifact.type,
          metadata: artifact.metadata
        });
      } else {
        this.log.warn('EventBus not available, cannot open file viewer');
      }
      return;
    }
    
    // For other artifacts (outputs, console, etc.), send to artifacts window
    if (this.aether?.ipc?.send) {
      // Switch to output tab (implicitly ensures visibility via send queueing)
      this.aether.ipc.send('artifacts:switch-tab', 'output');
      
      // Determine format based on artifact type and content
      // Schema only accepts: 'text', 'html', 'json', 'markdown'
      let format = 'text';
      if (artifact.type === 'html' || (artifact.content && artifact.content.trim().startsWith('<'))) {
        format = 'html';
      } else if (artifact.type === 'markdown' || displayName?.endsWith('.md')) {
        format = 'markdown';
      } else if (artifact.type === 'json' || displayName?.endsWith('.json')) {
        format = 'json';
      }
      // Note: Other formats default to 'text' per schema constraints
      
      // Send artifact content directly via load-output (bypasses cache lookup)
      // Schema expects: { output: string, format?: 'text'|'html'|'json'|'markdown' }
      this.aether.ipc.send('artifacts:load-output', {
        output: artifact.content || '',
        format: format
      });
      
      this.log.debug('Sent artifact to artifacts window via IPC', { 
        artifactId,
        type: artifact.type,
        format,
        contentLength: artifact.content?.length || 0
      });
    } else {
      this.log.warn('IPC unavailable; cannot open artifacts window', { artifactId });
    }
    
    // Close modal after opening
    this.close();
  }

  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  _formatTimestamp(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  _displayEmpty() {
    this._clearBodyListeners();
    this.bodyEl.innerHTML = `
      <div class="modal-empty-state">
        <div class="modal-empty-title">No files found</div>
        <div class="modal-empty-text">Files include attachments, code outputs, and generated content.</div>
      </div>
    `;
  }

  async _handleDeleteArtifact(artifact) {
    const artifactId = artifact.id;
    const displayName = artifact.title || artifact.filename || artifact.type;
    
    const confirmed = await ConfirmDialog.confirm({
      title: 'Delete file',
      message: `Delete "${displayName}"? This action cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger'
    });
    if (!confirmed) return;
    
    try {
      const endpoint = this.endpoint;
      if (!endpoint) {
        throw new Error('Endpoint not available');
      }
      
      // Delete artifact via API
      await endpoint.deleteArtifact(artifactId);
      
      this.log.info('Artifact deleted', { artifactId, displayName });
      
      // Emit event for chat UI to update
      if (this.eventBus) {
        this.eventBus.emit(EventTypes.ARTIFACTS.ARTIFACT_DELETED, {
          chatId: this.chatId,
          artifactId: artifactId
        });
      }
      
      // Reload modal content to reflect deletion
      await this._loadArtifactData();
      
      // Show deletion feedback (use info, not success, for destructive actions)
      Toast.info(`Deleted "${displayName}"`);
      
    } catch (error) {
      this.log.error('Failed to delete artifact', { error, artifactId });
      Toast.error(`Failed to delete: ${error.message || 'Unknown error'}`);
    }
  }

  /** @private */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  /** @private */
  _clearBodyListeners() {
    if (!this.bodyEl) return;
    const remaining = [];
    for (const listener of this._listeners) {
      if (listener.element && this.bodyEl.contains(listener.element)) {
        listener.element.removeEventListener(listener.event, listener.handler, listener.options);
      } else {
        remaining.push(listener);
      }
    }
    this._listeners = remaining;
  }

  /** @private */
  _clearTrackedListeners() {
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];
  }

  _cleanup() {
    this._requestSequence++;
    this._clearTrackedListeners();
    this.chatId = null;
    this.artifacts = [];
  }

  _displayError() {
    this._clearBodyListeners();
    this.bodyEl.innerHTML = `
      <div class="modal-empty-state">
        <div class="modal-empty-title cm-error-title">Failed to load files</div>
        <div class="modal-empty-text">Please try again later.</div>
      </div>
    `;
  }
}

module.exports = ChatFilesModal;
