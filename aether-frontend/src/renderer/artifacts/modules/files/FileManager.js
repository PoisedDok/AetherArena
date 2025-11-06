'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.init(), EventBus (ARTIFACTS.CHAT_SWITCHED, ARTIFACTS.ARTIFACT_ADDED, ARTIFACTS.FILE_SELECTED), ArtifactSessionManager.getSessionArtifacts() --- {artifact_types.session_data, object}
 * Processing: Display session artifacts grouped by message/execution, categorize by type (code/output), link related artifacts, handle file selection, sync on chat switch, render visual hierarchy --- {7 jobs: JOB_CLEAR_STATE, JOB_CREATE_DOM_ELEMENT, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: DOM (grouped file tree with categories), EventBus (ARTIFACTS.FILE_SELECTED, ARTIFACTS.FILE_OPENED), ArtifactsController.loadArtifact() --- {dom_types.html_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/files/FileManager
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { freeze } = Object;

const CONFIG = freeze({
  CLASS_NAMES: freeze({
    CONTAINER: 'file-manager-container',
    HEADER: 'file-manager-header',
    CONTROLS: 'file-controls',
    FILTER: 'file-filter-group',
    LIST: 'file-list',
    GROUP: 'file-group',
    GROUP_HEADER: 'file-group-header',
    GROUP_ITEMS: 'file-group-items',
    ITEM: 'file-item',
    ITEM_ICON: 'file-item-icon',
    ITEM_NAME: 'file-item-name',
    ITEM_META: 'file-item-meta',
    ACTIVE: 'active',
    LINKED: 'linked',
    EMPTY: 'empty-state',
    LOADING: 'loading-state',
  }),
  CATEGORIES: freeze({
    CODE: { label: 'Code', icon: '📝', key: 'code_written' },
    OUTPUT: { label: 'Output', icon: '📊', key: 'execution_output' },
    CONSOLE: { label: 'Console', icon: '⚡', key: 'execution_console' },
    HTML: { label: 'HTML', icon: '🌐', key: 'html_output' },
  }),
  FILTERS: freeze(['all', 'code', 'output', 'linked']),
});

class FileManager {
  constructor(options = {}) {
    if (!options.controller) {
      throw new Error('[FileManager] Controller required');
    }

    if (!options.eventBus) {
      throw new Error('[FileManager] EventBus required');
    }

    this.controller = options.controller;
    this.eventBus = options.eventBus;
    this.sessionManager = options.sessionManager || null;

    this.container = null;
    this.headerEl = null;
    this.controlsEl = null;
    this.listEl = null;

    this.currentChatId = null;
    this.currentFilter = 'all';
    this.selectedArtifactId = null;
    this.artifacts = [];
    this.groups = [];

    this._eventListeners = [];
    this._initialized = false;
  }

  async init(container) {
    if (this._initialized) {
      return;
    }

    console.log('📁 FileManager: Initializing...');

    try {
      if (!container) {
        throw new Error('[FileManager] Container required');
      }

      this.container = container;

      this._initializeSessionManager();
      this._createElement();
      this._injectStyles();
      this._setupEventListeners();

      this._initialized = true;

      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'FileManager',
        timestamp: Date.now()
      });

      console.log('✅ FileManager: Initialized');

    } catch (error) {
      console.error('❌ FileManager: Initialization failed:', error);
      throw error;
    }
  }

  dispose() {
    console.log('🛑 FileManager: Disposing...');

    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[FileManager] Failed to cleanup:', error);
      }
    }
    this._eventListeners = [];

    this.container = null;
    this.headerEl = null;
    this.controlsEl = null;
    this.listEl = null;

    this._initialized = false;

    console.log('✅ FileManager: Disposed');
  }

  _initializeSessionManager() {
    if (this.sessionManager) {
      return;
    }

    if (typeof window !== 'undefined' && window.artifactSessionManager) {
      this.sessionManager = window.artifactSessionManager;
    } else if (this.controller.sessionManager) {
      this.sessionManager = this.controller.sessionManager;
    }
  }

  async loadFiles(chatId = null) {
    try {
      this.currentChatId = chatId;

      if (!chatId) {
        this._renderEmpty('No chat selected');
        return;
      }

      this._renderLoading();

      if (this.sessionManager) {
        const sessionData = await this.sessionManager.switchSession(chatId);
        this.artifacts = sessionData.artifacts || [];
        this.groups = sessionData.groups || [];
      } else {
      if (!window.storageAPI || typeof window.storageAPI.loadArtifacts !== 'function') {
          throw new Error('Storage API not available');
      }

      const artifacts = await window.storageAPI.loadArtifacts(chatId);
        this.artifacts = artifacts;
        this.groups = this._groupArtifacts(artifacts);
      }

      this._renderFiles();

      console.log(`[FileManager] Loaded ${this.artifacts.length} artifacts, ${this.groups.length} groups`);

    } catch (error) {
      console.error('[FileManager] Load files failed:', error);
      this._renderError(error);
    }
  }

  _groupArtifacts(artifacts) {
    const groups = new Map();

    for (const artifact of artifacts) {
      const key = artifact.messageId || artifact.correlationId || 'ungrouped';

      if (!groups.has(key)) {
        groups.set(key, {
          messageId: key,
          artifacts: [],
          codeArtifacts: [],
          outputArtifacts: [],
        });
      }

      const group = groups.get(key);
      group.artifacts.push(artifact);

      const category = this._getArtifactCategory(artifact);
      if (category === 'code_written') {
        group.codeArtifacts.push(artifact);
      } else if (category.includes('output') || category.includes('console')) {
        group.outputArtifacts.push(artifact);
      }
    }

    return Array.from(groups.values());
  }

  _getArtifactCategory(artifact) {
    if (artifact.category) {
      return artifact.category;
    }

    if (artifact.role === 'assistant' && artifact.type === 'code') {
      return 'code_written';
    }

    if (artifact.role === 'computer' && artifact.type === 'console') {
      return 'execution_console';
    }

    if (artifact.role === 'computer' && artifact.type === 'code') {
      return 'execution_output';
    }

    if (artifact.format === 'html') {
      return 'html_output';
    }

    return 'general_output';
  }

  _createElement() {
    this.container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);

    this.headerEl = document.createElement('div');
    this.headerEl.className = CONFIG.CLASS_NAMES.HEADER;
    this.headerEl.innerHTML = `
      <span class="file-manager-title">Files</span>
      <span class="file-manager-count">0</span>
    `;

    this.controlsEl = document.createElement('div');
    this.controlsEl.className = CONFIG.CLASS_NAMES.CONTROLS;

    const filterGroup = document.createElement('div');
    filterGroup.className = CONFIG.CLASS_NAMES.FILTER;

    for (const filter of CONFIG.FILTERS) {
      const btn = document.createElement('button');
      btn.className = 'filter-btn';
      btn.dataset.filter = filter;
      btn.textContent = filter.charAt(0).toUpperCase() + filter.slice(1);
      
      if (filter === this.currentFilter) {
        btn.classList.add(CONFIG.CLASS_NAMES.ACTIVE);
      }

      btn.addEventListener('click', () => this._handleFilterChange(filter));
      filterGroup.appendChild(btn);
    }

    this.controlsEl.appendChild(filterGroup);

    this.listEl = document.createElement('div');
    this.listEl.className = CONFIG.CLASS_NAMES.LIST;

    this.container.appendChild(this.headerEl);
    this.container.appendChild(this.controlsEl);
    this.container.appendChild(this.listEl);
  }

  _setupEventListeners() {
    const cleanupChatSwitch = this.eventBus.on(EventTypes.ARTIFACTS.CHAT_SWITCHED, (data) => {
      this.loadFiles(data.chatId);
    });
    this._eventListeners.push(cleanupChatSwitch);

    const cleanupArtifactAdded = this.eventBus.on(EventTypes.ARTIFACTS.ARTIFACT_ADDED, (data) => {
      if (data.chatId === this.currentChatId) {
        this.loadFiles(this.currentChatId);
      }
    });
    this._eventListeners.push(cleanupArtifactAdded);
  }

  _renderFiles() {
    this.listEl.innerHTML = '';

    const filteredGroups = this._applyFilter();

    if (filteredGroups.length === 0) {
      this._renderEmpty('No artifacts match filter');
      return;
    }

    this._updateCount(filteredGroups);

    for (const group of filteredGroups) {
      this._renderGroup(group);
    }
  }

  _applyFilter() {
    switch (this.currentFilter) {
      case 'code':
        return this.groups.filter(g => g.codeArtifacts.length > 0);
      
      case 'output':
        return this.groups.filter(g => g.outputArtifacts.length > 0);
      
      case 'linked':
        return this.groups.filter(g => 
          g.codeArtifacts.length > 0 && g.outputArtifacts.length > 0
        );
      
      case 'all':
      default:
        return this.groups;
    }
  }

  _renderGroup(group) {
    const groupEl = document.createElement('div');
    groupEl.className = CONFIG.CLASS_NAMES.GROUP;

    const headerEl = document.createElement('div');
    headerEl.className = CONFIG.CLASS_NAMES.GROUP_HEADER;
    
    const isLinked = group.codeArtifacts.length > 0 && group.outputArtifacts.length > 0;
    const linkLabel = isLinked ? 'Execution' : 'Group';
    
    headerEl.innerHTML = `
      <span class="group-label">${linkLabel} ${this._getGroupIndex(group)}</span>
      <span class="group-badge">${group.artifacts.length}</span>
    `;

    const itemsEl = document.createElement('div');
    itemsEl.className = CONFIG.CLASS_NAMES.GROUP_ITEMS;

    const sortedArtifacts = [...group.artifacts].sort((a, b) => {
      const catA = this._getArtifactCategory(a);
      const catB = this._getArtifactCategory(b);
      const order = { code_written: 0, execution_console: 1, execution_output: 2, html_output: 3 };
      return (order[catA] || 99) - (order[catB] || 99);
    });

    for (const artifact of sortedArtifacts) {
      const itemEl = this._createItemElement(artifact, isLinked);
      itemsEl.appendChild(itemEl);
    }

    groupEl.appendChild(headerEl);
    groupEl.appendChild(itemsEl);
    this.listEl.appendChild(groupEl);
  }

  _createItemElement(artifact, isLinked) {
    const itemEl = document.createElement('div');
    itemEl.className = CONFIG.CLASS_NAMES.ITEM;
    itemEl.dataset.artifactId = artifact.id;
    
    if (artifact.id === this.selectedArtifactId) {
      itemEl.classList.add(CONFIG.CLASS_NAMES.ACTIVE);
    }
    
    if (isLinked) {
      itemEl.classList.add(CONFIG.CLASS_NAMES.LINKED);
    }

    const category = this._getArtifactCategory(artifact);
    const icon = this._getCategoryIcon(category);
    const name = artifact.filename || this._generateName(artifact);
    const meta = this._generateMeta(artifact);

    itemEl.innerHTML = `
      <span class="${CONFIG.CLASS_NAMES.ITEM_ICON}">${icon}</span>
      <span class="${CONFIG.CLASS_NAMES.ITEM_NAME}">${name}</span>
      <span class="${CONFIG.CLASS_NAMES.ITEM_META}">${meta}</span>
    `;

    itemEl.addEventListener('click', () => this._handleFileClick(artifact));

    return itemEl;
  }

  _getCategoryIcon(category) {
    switch (category) {
      case 'code_written': return CONFIG.CATEGORIES.CODE.icon;
      case 'execution_output': return CONFIG.CATEGORIES.OUTPUT.icon;
      case 'execution_console': return CONFIG.CATEGORIES.CONSOLE.icon;
      case 'html_output': return CONFIG.CATEGORIES.HTML.icon;
      default: return '📄';
    }
  }

  _generateName(artifact) {
    const category = this._getArtifactCategory(artifact);
    const format = artifact.format || artifact.language || 'txt';
    
    switch (category) {
      case 'code_written': return `code.${format}`;
      case 'execution_output': return `output.${format}`;
      case 'execution_console': return 'console.log';
      case 'html_output': return 'output.html';
      default: return `artifact.${format}`;
    }
  }

  _generateMeta(artifact) {
    const size = artifact.content?.length || 0;
    const sizeStr = size > 1024 ? `${(size / 1024).toFixed(1)}KB` : `${size}B`;
    return `${artifact.format || 'txt'} • ${sizeStr}`;
  }

  _getGroupIndex(group) {
    const index = this.groups.indexOf(group) + 1;
    return index;
  }

  _updateCount(groups) {
    const countEl = this.headerEl.querySelector('.file-manager-count');
    const total = groups.reduce((sum, g) => sum + g.artifacts.length, 0);
    countEl.textContent = total;
  }

  _handleFilterChange(filter) {
    this.currentFilter = filter;

    const buttons = this.controlsEl.querySelectorAll('.filter-btn');
    buttons.forEach(btn => {
      if (btn.dataset.filter === filter) {
        btn.classList.add(CONFIG.CLASS_NAMES.ACTIVE);
      } else {
        btn.classList.remove(CONFIG.CLASS_NAMES.ACTIVE);
      }
    });

    this._renderFiles();
  }

  _handleFileClick(artifact) {
    console.log('[FileManager] File clicked:', artifact.id);

    this.selectedArtifactId = artifact.id;

    const items = this.listEl.querySelectorAll(`.${CONFIG.CLASS_NAMES.ITEM}`);
    items.forEach(item => {
      if (item.dataset.artifactId === artifact.id) {
        item.classList.add(CONFIG.CLASS_NAMES.ACTIVE);
      } else {
        item.classList.remove(CONFIG.CLASS_NAMES.ACTIVE);
      }
    });

    this.eventBus.emit(EventTypes.ARTIFACTS.FILE_SELECTED, { artifact });

    if (this.controller && typeof this.controller.loadArtifact === 'function') {
      this.controller.loadArtifact(artifact);
    }
  }

  highlightArtifact(artifactId) {
    this.selectedArtifactId = artifactId;

    const items = this.listEl.querySelectorAll(`.${CONFIG.CLASS_NAMES.ITEM}`);
    items.forEach(item => {
      if (item.dataset.artifactId === artifactId) {
        item.classList.add(CONFIG.CLASS_NAMES.ACTIVE);
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        item.classList.remove(CONFIG.CLASS_NAMES.ACTIVE);
      }
    });
  }

  _renderLoading() {
    this.listEl.innerHTML = `<div class="${CONFIG.CLASS_NAMES.LOADING}">Loading artifacts...</div>`;
  }

  _renderEmpty(message) {
    this.listEl.innerHTML = `<div class="${CONFIG.CLASS_NAMES.EMPTY}">${message}</div>`;
  }

  _renderError(error) {
    this.listEl.innerHTML = `<div style="padding: 16px; color: #d32f2f;">${error.message}</div>`;
  }

  _injectStyles() {
    const styleId = 'file-manager-styles';

    if (document.getElementById(styleId)) {
      return;
    }

    const styles = `
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
        background: rgba(15, 15, 15, 0.95);
      }

      .${CONFIG.CLASS_NAMES.HEADER} {
        padding: 12px 16px;
        background: rgba(25, 25, 30, 0.95);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }

      .file-manager-title {
        font-size: 14px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.95);
      }

      .file-manager-count {
        font-size: 12px;
        padding: 2px 8px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 10px;
        color: rgba(255, 255, 255, 0.85);
      }

      .${CONFIG.CLASS_NAMES.CONTROLS} {
        padding: 8px 12px;
        background: rgba(20, 20, 25, 0.9);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        flex-shrink: 0;
      }

      .${CONFIG.CLASS_NAMES.FILTER} {
        display: flex;
        gap: 6px;
      }

      .filter-btn {
        padding: 4px 12px;
        font-size: 11px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.6);
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 6px;
        cursor: pointer;
        transition: all 200ms ease;
      }

      .filter-btn:hover {
        color: rgba(255, 255, 255, 0.95);
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.2);
      }

      .filter-btn.${CONFIG.CLASS_NAMES.ACTIVE} {
        color: rgba(255, 255, 255, 0.98);
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.3);
      }

      .${CONFIG.CLASS_NAMES.LIST} {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
      }

      .${CONFIG.CLASS_NAMES.GROUP} {
        margin-bottom: 16px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid rgba(255, 255, 255, 0.06);
        overflow: hidden;
      }

      .${CONFIG.CLASS_NAMES.GROUP_HEADER} {
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.03);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.8);
      }

      .group-icon {
        font-size: 14px;
      }

      .group-label {
        flex: 1;
      }

      .group-badge {
        font-size: 10px;
        padding: 2px 6px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        color: rgba(255, 255, 255, 0.75);
      }

      .${CONFIG.CLASS_NAMES.GROUP_ITEMS} {
        padding: 6px;
      }

      .${CONFIG.CLASS_NAMES.ITEM} {
        padding: 10px 12px;
        margin-bottom: 4px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        cursor: pointer;
        transition: all 200ms ease;
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .${CONFIG.CLASS_NAMES.ITEM}:hover {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.15);
        transform: translateX(2px);
      }

      .${CONFIG.CLASS_NAMES.ITEM}.${CONFIG.CLASS_NAMES.ACTIVE} {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.25);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
      }

      .${CONFIG.CLASS_NAMES.ITEM}.${CONFIG.CLASS_NAMES.LINKED} {
        position: relative;
      }
      
      .${CONFIG.CLASS_NAMES.ITEM}.${CONFIG.CLASS_NAMES.LINKED}::after {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 2px;
        background: rgba(255, 255, 255, 0.3);
        border-radius: 2px;
      }

      .${CONFIG.CLASS_NAMES.ITEM_ICON} {
        font-size: 16px;
        flex-shrink: 0;
      }

      .${CONFIG.CLASS_NAMES.ITEM_NAME} {
        flex: 1;
        font-size: 13px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.9);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .${CONFIG.CLASS_NAMES.ITEM_META} {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.5);
        flex-shrink: 0;
      }

      .${CONFIG.CLASS_NAMES.EMPTY}, .${CONFIG.CLASS_NAMES.LOADING} {
        padding: 32px 16px;
        text-align: center;
        color: rgba(255, 255, 255, 0.4);
        font-size: 13px;
      }
    `;

    const styleElement = document.createElement('style');
    styleElement.id = styleId;
    styleElement.textContent = styles;
    document.head.appendChild(styleElement);
  }
}

module.exports = FileManager;

if (typeof window !== 'undefined') {
  window.FileManager = FileManager;
  console.log('📦 FileManager loaded');
}
