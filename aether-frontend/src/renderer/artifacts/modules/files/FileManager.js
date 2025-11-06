'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController (loadFiles method), EventBus (ARTIFACTS.CHAT_SWITCHED), window.storageAPI.loadArtifacts() --- {database_types.artifact_record[], json}
 * Processing: Query PostgreSQL via storageAPI for artifact list by chatId, render file list with metadata (filename, type), handle file selection, refresh on chat switch --- {5 jobs: JOB_LOAD_FROM_DB, JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_GET_STATE}
 * Outgoing: DOM (scrollable file list), EventBus (ARTIFACTS.FILE_SELECTED) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/files/FileManager
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { freeze } = Object;

const CONFIG = freeze({
  CLASS_NAMES: freeze({
    CONTAINER: 'file-manager-container',
    CONTROLS: 'file-controls',
    LIST: 'file-list',
    ITEM: 'file-item',
    ACTIVE: 'active',
    EMPTY: 'empty-state',
  }),
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

    // DOM elements
    this.container = null;
    this.controlsContainer = null;
    this.listContainer = null;

    // State
    this.files = [];
    this.currentChatId = null;
    this.currentFilter = 'all';

    // Event handlers
    this._eventListeners = [];
  }

  async init(container) {
    console.log('📁 FileManager: Initializing...');

    try {
      if (!container) {
        throw new Error('[FileManager] Container required');
      }

      this.container = container;

      this._createElement();
      this._injectStyles();

      // Listen for chat changes
      this._setupEventListeners();

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
    this.controlsContainer = null;
    this.listContainer = null;

    console.log('✅ FileManager: Disposed');
  }

  async loadFiles(chatId = null) {
    try {
      this.currentChatId = chatId;

      if (!chatId) {
        this._renderEmpty('No chat selected');
        return;
      }

      this._renderLoading();

      // Load from PostgreSQL via storageAPI
      if (!window.storageAPI || typeof window.storageAPI.loadArtifacts !== 'function') {
        throw new Error('StorageAPI not available');
      }

      const artifacts = await window.storageAPI.loadArtifacts(chatId);
      this.files = artifacts;

      this._renderFiles();

      console.log(`[FileManager] Loaded ${artifacts.length} files`);

    } catch (error) {
      console.error('[FileManager] Load files failed:', error);
      this._renderError(error);
    }
  }

  _createElement() {
    this.container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);

    // Controls
    this.controlsContainer = document.createElement('div');
    this.controlsContainer.className = CONFIG.CLASS_NAMES.CONTROLS;

    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '🔄 Refresh';
    refreshBtn.addEventListener('click', () => this.loadFiles(this.currentChatId));
    this.controlsContainer.appendChild(refreshBtn);

    // List
    this.listContainer = document.createElement('div');
    this.listContainer.className = CONFIG.CLASS_NAMES.LIST;

    this.container.appendChild(this.controlsContainer);
    this.container.appendChild(this.listContainer);
  }

  _setupEventListeners() {
    // Listen for chat switches
    const cleanup = this.eventBus.on(EventTypes.ARTIFACTS.CHAT_SWITCHED, (data) => {
      this.loadFiles(data.chatId);
    });

    this._eventListeners.push(cleanup);
  }

  _renderFiles() {
    this.listContainer.innerHTML = '';

    if (this.files.length === 0) {
      this._renderEmpty('No artifacts found');
      return;
    }

    for (const file of this.files) {
      const item = document.createElement('div');
      item.className = CONFIG.CLASS_NAMES.ITEM;
      item.textContent = file.filename || `Artifact ${file.artifact_id}`;
      item.title = `Type: ${file.language || 'unknown'}`;
      
      item.addEventListener('click', () => {
        this._handleFileClick(file);
      });

      this.listContainer.appendChild(item);
    }
  }

  _renderLoading() {
    this.listContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: #999;">Loading files...</div>';
  }

  _renderEmpty(message) {
    this.listContainer.innerHTML = `<div class="${CONFIG.CLASS_NAMES.EMPTY}">${message}</div>`;
  }

  _renderError(error) {
    this.listContainer.innerHTML = `<div style="padding: 16px; color: #d32f2f;">${error.message}</div>`;
  }

  _handleFileClick(file) {
    console.log('[FileManager] File clicked:', file.artifact_id);
    
    // Emit event for other modules to handle
    this.eventBus.emit(EventTypes.ARTIFACTS.FILE_SELECTED, { file });
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
      }

      .${CONFIG.CLASS_NAMES.CONTROLS} {
        padding: 8px;
        background: rgba(25, 25, 30, 0.9);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        flex-shrink: 0;
      }

      .${CONFIG.CLASS_NAMES.CONTROLS} button {
        padding: 6px 12px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.8);
        background: rgba(255, 100, 0, 0.1);
        border: 1px solid rgba(255, 100, 0, 0.3);
        border-radius: 6px;
        cursor: pointer;
      }

      .${CONFIG.CLASS_NAMES.LIST} {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
      }

      .${CONFIG.CLASS_NAMES.ITEM} {
        padding: 12px;
        margin-bottom: 8px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        cursor: pointer;
        transition: all 200ms ease;
        color: rgba(255, 255, 255, 0.9);
      }

      .${CONFIG.CLASS_NAMES.ITEM}:hover {
        background: rgba(255, 100, 0, 0.1);
        border-color: rgba(255, 100, 0, 0.3);
      }

      .${CONFIG.CLASS_NAMES.EMPTY} {
        padding: 32px;
        text-align: center;
        color: rgba(255, 255, 255, 0.5);
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

