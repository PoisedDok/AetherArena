'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController loadFiles, EventBus artifact lifecycle events --- {Dict, json}
 * Processing: Normalize artifacts, group by execution, render file hierarchy, emit selection telemetry --- {5 jobs: JOB_FILTER_DATA, JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_APPEND_TO_CONTAINER}
 * Outgoing: Rendered file manager DOM, EventBus 'artifacts:file:selected', controller.loadArtifact calls --- {HTMLElement, json}
 * 
 * 
 * @module renderer/artifacts/modules/files/FileManager
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { normalizeArtifactPayload } = require('../../../../application/artifacts/ArtifactNormalizer');
const { createRendererLogger } = require('../../../shared/utils/logger');
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
  // ARCHITECTURAL ENFORCEMENT: See contracts/README.md (Trail hierarchy + artifact invariants)
  // Artifact types: code (writing node) + output (output node) + file (user attachments)
  CATEGORIES: freeze({
    CODE: { 
      label: 'Code', 
      icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`, 
      key: 'code' 
    },
    OUTPUT: { 
      label: 'Output', 
      icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`, 
      key: 'output' 
    },
    CONSOLE: { 
      label: 'Console', 
      icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`, 
      key: 'console' 
    },
    ATTACHMENT: { 
      label: 'Attachments', 
      icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>`, 
      key: 'attachment' 
    },
  }),
  FILTERS: freeze(['all', 'code', 'output', 'attachment', 'linked']),
});

class FileManager {
  constructor(options = {}) {
    this.log = createRendererLogger('FileManager');
    if (!options.controller) {
      throw new Error('[FileManager] Controller required');
    }

    if (!options.eventBus) {
      throw new Error('[FileManager] EventBus required');
    }

    this.log.debug('[FileManager] Constructor:', {
      hasController: !!options.controller,
      hasEventBus: !!options.eventBus,
      hasStorageAPI: !!options.storageAPI,
      storageAPIType: options.storageAPI ? options.storageAPI.constructor.name : 'undefined'
    });

    this.controller = options.controller;
    this.eventBus = options.eventBus;
    this.sessionManager = options.sessionManager || null;
    this.storageAPI = options.storageAPI || null;

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
    this._domListeners = [];
    this._itemListeners = []; // BUG FM-1 FIX: Track per-item DOM listeners for cleanup before re-render
    this._activeModalTeardown = null; // BUG FM-3 FIX: Track open modal teardown for cleanup on dispose
    this._initialized = false;
    this._isDisposed = false; // BUG FM-4 FIX: Guard against post-dispose operations
    this._updateDebounceTimer = null;
  }

  async init(container) {
    // BUG FM-11 FIX: Prevent zombie resurrection after dispose
    if (this._isDisposed) return;
    if (this._initialized) {
      return;
    }

    this.log.debug('FileManager: Initializing...', {
      hasController: !!this.controller,
      hasStorageAPI: !!this.storageAPI,
      hasStorageAPIClient: !!(this.storageAPI && this.storageAPI.client)
    });

    try {
      if (!container) {
        throw new Error('[FileManager] Container required');
      }

      this.container = container;

      this._initializeSessionManager();
      this._createElement();
      this._setupEventListeners();

      this._initialized = true;

      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'FileManager',
        timestamp: Date.now()
      });

      this.log.debug('FileManager: Initialized');

    } catch (error) {
      this.log.error('FileManager: Initialization failed:', error);
      throw error;
    }
  }

  dispose() {
    if (this._isDisposed) return; // Idempotent
    this.log.debug('FileManager: Disposing...');

    // BUG FM-4 FIX: Set disposed flag FIRST to prevent new operations
    this._isDisposed = true;

    // BUG FM-3 FIX: Close any open modal before tearing down DOM
    if (this._activeModalTeardown) {
      try { this._activeModalTeardown(); } catch (_) { /* modal may already be closed */ }
      this._activeModalTeardown = null;
    }

    if (this._updateDebounceTimer) {
      clearTimeout(this._updateDebounceTimer);
      this._updateDebounceTimer = null;
    }

    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('[FileManager] Failed to cleanup:', error);
      }
    }
    this._eventListeners = [];

    // BUG FM-1 FIX: Clean item listeners before DOM teardown
    this._cleanupItemListeners();

    // Clean DOM listeners
    for (const { el, event, handler } of this._domListeners) {
      try { el.removeEventListener(event, handler); } catch (_) { /* element may already be gone */ }
    }
    this._domListeners = [];

    if (this._addFileDebounceTimer) {
      clearTimeout(this._addFileDebounceTimer);
      this._addFileDebounceTimer = null;
    }
    
    if (this._updateDebounceTimer) {
      clearTimeout(this._updateDebounceTimer);
      this._updateDebounceTimer = null;
    }

    this.container = null;
    this.headerEl = null;
    this.controlsEl = null;
    this.listEl = null;

    // BUG FM-10 FIX: Release references to artifact data for garbage collection
    this.artifacts = [];
    this.groups = [];
    this.currentChatId = null;
    this.selectedArtifactId = null;

    // Fix Reference Leaks
    this.controller = null;
    this.eventBus = null;
    this.sessionManager = null;
    this.storageAPI = null;

    this._initialized = false;

    this.log.debug('FileManager: Disposed');
  }

  _trackDOMListener(el, event, handler) {
    el.addEventListener(event, handler);
    this._domListeners.push({ el, event, handler });
  }

  /**
   * BUG FM-1 FIX: Track a listener attached to a rendered file item element.
   * These are cleaned before every re-render and on dispose.
   */
  _trackItemListener(el, event, handler) {
    el.addEventListener(event, handler);
    this._itemListeners.push({ el, event, handler });
  }

  /**
   * BUG FM-1 FIX: Remove all tracked item listeners. Called before re-render
   * (which wipes the DOM via innerHTML='') and during dispose.
   */
  _cleanupItemListeners() {
    for (const { el, event, handler } of this._itemListeners) {
      try { el.removeEventListener(event, handler); } catch (_) { /* element may already be gone */ }
    }
    this._itemListeners = [];
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
    if (this._isDisposed) return; // BUG FM-4 FIX
    try {
      this.currentChatId = chatId;

      if (!chatId) {
        this._renderEmpty('No chat selected');
        return;
      }

      this._renderLoading();

      // Load artifacts from multiple sources and merge
      const artifactMap = new Map(); // Use Map to deduplicate by ID

      // 1. Load from session manager (in-memory current session)
      if (this.sessionManager) {
        try {
          const sessionData = await this.sessionManager.switchSession(chatId);
          if (this._isDisposed) return;
          const sessionArtifacts = sessionData.artifacts || [];
          sessionArtifacts.forEach(art => artifactMap.set(art.id, art));
          this.log.debug(`[FileManager] Loaded from session manager: ${sessionArtifacts.length} artifacts`);
        } catch (error) {
          this.log.warn('[FileManager] Session manager load failed:', error);
        }
      }

      // 2. ALWAYS try to load persisted artifacts from previous sessions
      // CLEAN ARCHITECTURE: FileManager → Controller → ArtifactService (domain) → ArtifactRepository → storageAPI (IPC)
      try {
        const persistedArtifacts = [];
        const rawArtifacts = await this.controller.loadArtifactsForChat(chatId);
        if (this._isDisposed) return;
        for (const artifact of rawArtifacts) {
          try {
            const normalized = normalizeArtifactPayload(artifact, chatId);
            persistedArtifacts.push(normalized);
            // Repopulate controller cache so other components (like ChatWindow) can find it
            if (this.controller && this.controller.artifactCache) {
              this.controller.artifactCache.set(normalized.id, normalized);
              this.controller.hasContent = true;
            }
          } catch (error) {
            this.log.error(`[FileManager] Failed to normalize persisted artifact: ${error.message}`, {
              artifactId: artifact?.id || artifact?.artifact_id || 'unknown',
              chatId: chatId.substring(0, 8)
            });
            // Skip corrupted artifacts - continue loading others
          }
        }
        persistedArtifacts.forEach(art => {
          // Don't overwrite in-memory artifacts with persisted ones (in-memory is more recent)
          if (!artifactMap.has(art.id)) {
            artifactMap.set(art.id, art);
          }
        });
        this.log.debug(`[FileManager] Loaded from controller (domain service): ${persistedArtifacts.length} artifacts`);
      } catch (error) {
        this.log.warn('[FileManager] Controller artifact load failed:', error);
      }

      // 3. Fallback to controller's in-memory artifacts (very recent, might not be in session yet)
      if (this.controller && this.controller.artifactCache) {
        const controllerArtifacts = Array.from(this.controller.artifactCache.values())
          .filter(a => {
            // CRITICAL FIX: Filter out phantom artifacts with invalid IDs
            // These are console START markers that created corrupted artifact records
            if (!a.id || a.id === 'NO_ID' || a.id === 'undefined' || a.id === 'null') {
              this.log.warn(`[FileManager] Skipping phantom artifact with invalid ID`, { 
                id: a.id, 
                role: a.role, 
                type: a.type,
                chatId: a.chatId?.substring(0, 8)
              });
              return false;
            }
            return a.chatId === chatId;
          });
        controllerArtifacts.forEach(art => {
          if (!artifactMap.has(art.id)) {
            artifactMap.set(art.id, art);
          }
        });
        if (controllerArtifacts.length > 0) {
          this.log.debug(`[FileManager] Loaded from controller: ${controllerArtifacts.length} artifacts`);
        }
      }

      // Convert Map to array and group
      const artifacts = Array.from(artifactMap.values());
      
      const groups = this._groupArtifacts(artifacts);

      this.artifacts = artifacts;
      this.groups = groups;

      this._renderFiles();

      this.log.debug(`[FileManager] Loaded ${this.artifacts.length} artifacts, ${this.groups.length} groups`);

    } catch (error) {
      this.log.error('[FileManager] Load files failed:', error);
      this._renderError(error);
    }
  }

  /**
   * Add a single file artifact (for streaming/real-time additions)
   * @param {Object} artifact - Artifact to add
   */
  addFile(artifact) {
    if (this._isDisposed) return; // BUG FM-4 FIX
    if (!artifact) {
      this.log.warn('[FileManager] addFile called with null/undefined artifact');
      return;
    }

    // Normalize artifact payload
    let normalized;
    try {
      normalized = normalizeArtifactPayload(artifact, this.currentChatId);
    } catch (error) {
      this.log.error(`[FileManager] Failed to normalize artifact: ${error.message}`, {
        artifactId: artifact?.id || artifact?.artifact_id || 'unknown',
        chatId: this.currentChatId?.substring(0, 8) || 'none'
      });
      return;
    }

    // Check if artifact already exists (prevent duplicates)
    const existingIndex = this.artifacts.findIndex(a => a.id === normalized.id);
    if (existingIndex !== -1) {
      // Update existing artifact instead of adding duplicate
      this.artifacts[existingIndex] = normalized;
      this.log.debug(`[FileManager] Updated existing artifact: ${normalized.id}`);
    } else {
      this.artifacts.push(normalized);
      this.log.debug(`[FileManager] Added new artifact: ${normalized.id} (${normalized.filename || normalized.title || 'untitled'})`);
    }

    // Re-group and re-render efficiently
    this.groups = this._groupArtifacts(this.artifacts);
    if (this._addFileDebounceTimer) {
      clearTimeout(this._addFileDebounceTimer);
    }
    this._addFileDebounceTimer = setTimeout(() => {
      if (this._isDisposed) return;
      this._renderFiles();
    }, 50);

    // Emit event
    this.eventBus.emit(EventTypes.ARTIFACTS.FILE_ADDED, { artifact: normalized });
  }

  /**
   * Group artifacts by subgroup (execution_group/backend_id)
   * ARCHITECTURAL ENFORCEMENT: See contracts/README.md (Trail hierarchy + artifact invariants)
   * - Each subgroup must have EXACTLY 2 artifacts: code + output
   * - Filter out ALL non-conforming artifacts
   * @param {Array} artifacts
   * @returns {Array} Grouped artifacts
   */
  _groupArtifacts(artifacts) {
    const groups = new Map();

    for (const artifact of artifacts) {
      // STRICT ARCHITECTURAL FILTER: code, output, and file (attachment) types allowed
      // Reference: contracts/README.md (Artifact types and invariants)

      // ALLOWED artifacts:
      // 1. assistant:code (writing node artifact)
      // 2. computer:output (output node artifact with format: html/json/console/text)
      // 3. type:file (user attachment - no role required)

      // REJECTED artifacts (violates schema):
      // - computer:code (duplicate)
      // - computer:console as separate type (should be output with format=console)
      // - computer:html as separate type (should be output with format=html)
      // - assistant:output (invalid role for output)

      const isCodeArtifact = artifact.role === 'assistant' && artifact.type === 'code';
      const isOutputArtifact = artifact.role === 'computer' && artifact.type === 'output';
      const isAttachment = artifact.type === 'file';

      // ARCHITECTURAL FIX: Filter out console artifacts that were persisted as output.
      // Console artifacts have raw_type='console' in metadata (set during streaming).
      // After type normalization, they appear as computer:output and pollute execution groups.
      const rawType = artifact.rawType || artifact.metadata?.raw_type;
      if (rawType === 'console') {
        continue;
      }

      if (!isCodeArtifact && !isOutputArtifact && !isAttachment) {
        // Skip non-conforming artifacts
        continue;
      }
      
      // SPECIAL HANDLING: Attachments are standalone files without executionGroup
      // They get their own individual groups (one attachment = one group)
      let key;
      if (isAttachment) {
        // Use artifact ID as group key for attachments (one file per group)
        key = artifact.id || artifact.artifact_id || `attachment_${artifact.filename || 'unknown'}`;
      } else {
        // Code/output artifacts: group by executionGroup (links related artifacts)
        if (!artifact.executionGroup || typeof artifact.executionGroup !== 'string') {
          throw new Error(`[FileManager] CONTRACT VIOLATION: artifact.executionGroup is required for code/output. artifactId=${artifact.id || artifact.artifactId || 'unknown'}`);
        }
        if (!artifact.request_id || typeof artifact.request_id !== 'string') {
          throw new Error(`[FileManager] CONTRACT VIOLATION: artifact.request_id is required for code/output. artifactId=${artifact.id || artifact.artifactId || 'unknown'}`);
        }
        key = artifact.executionGroup;
      }

      if (!groups.has(key)) {
        groups.set(key, {
          messageId: key,
          executionGroup: isAttachment ? key : artifact.executionGroup,
          artifacts: [],
          codeArtifacts: [],
          outputArtifacts: [],
          attachmentArtifacts: [],
        });
      }

      const group = groups.get(key);
      group.artifacts.push(artifact);

      if (isCodeArtifact) {
        group.codeArtifacts.push(artifact);
      } else if (isOutputArtifact) {
        group.outputArtifacts.push(artifact);
      } else if (isAttachment) {
        group.attachmentArtifacts.push(artifact);
      }
    }

    // ARCHITECTURAL ENFORCEMENT: Trim execution groups to exactly 1 code + 1 output.
    // Legacy data may contain persisted console artifacts (normalized to type=output)
    // which pollute execution groups with extra files.
    // Attachment groups remain 1 artifact each (standalone file).
    for (const [key, group] of groups.entries()) {
      const isAttachmentGroup = group.attachmentArtifacts.length > 0;
      
      if (!isAttachmentGroup) {
        // INVARIANT: Execution groups must have exactly 1 code + 1 output.
        // If we have duplicates (e.g., console persisted as output), keep only the first
        // of each type, preferring non-text format for output (html > json > text).
        if (group.codeArtifacts.length > 1) {
          this.log.warn(`[FileManager] Group ${key}: trimming ${group.codeArtifacts.length} code artifacts to 1`);
          group.codeArtifacts = group.codeArtifacts.slice(0, 1);
        }
        
        if (group.outputArtifacts.length > 1) {
          // Prefer the output artifact with the richest format (html > json > text)
          const formatPriority = { html: 0, json: 1, markdown: 2, text: 3 };
          group.outputArtifacts.sort((a, b) => {
            const fmtA = (a.format || 'text').toLowerCase();
            const fmtB = (b.format || 'text').toLowerCase();
            return (formatPriority[fmtA] ?? 99) - (formatPriority[fmtB] ?? 99);
          });
          this.log.warn(`[FileManager] Group ${key}: trimming ${group.outputArtifacts.length} output artifacts to 1 (kept format: ${group.outputArtifacts[0]?.format})`);
          group.outputArtifacts = group.outputArtifacts.slice(0, 1);
        }
        
        // Rebuild artifacts array from trimmed sub-arrays
        group.artifacts = [...group.codeArtifacts, ...group.outputArtifacts];
      }
      
      const artifactCount = group.artifacts.length;
      const expectedCount = isAttachmentGroup ? 1 : 2;
      
      if (artifactCount !== expectedCount) {
        this.log.warn(`[FileManager] Group ${key} has ${artifactCount} artifacts (expected ${expectedCount})`, {
          codeCount: group.codeArtifacts.length,
          outputCount: group.outputArtifacts.length,
          attachmentCount: group.attachmentArtifacts.length,
        });
      }
    }

    return Array.from(groups.values());
  }

  /**
   * Get artifact category based on role and type
   * ARCHITECTURAL ENFORCEMENT: code, output, and attachment categories
   * @param {Object} artifact
   * @returns {string} Category key ('code', 'output', or 'attachment')
   */
  _getArtifactCategory(artifact) {
    if (artifact.category) {
      return artifact.category;
    }

    // Reference: contracts/README.md:
    // - assistant:code → writing node artifact
    // - computer:output → output node artifact (format field specifies rendering: html/json/console/text)
    // - type:file → user attachment (no role required)
    
    if (artifact.role === 'assistant' && artifact.type === 'code') {
      return 'code';
    }

    if (artifact.role === 'computer' && artifact.type === 'output') {
      return 'output';
    }

    if (artifact.type === 'file') {
      return 'attachment';
    }

    // All other combinations are schema violations - return null to filter out
    return null;
  }

  _createElement() {
    this.container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);

    this.headerEl = document.createElement('div');
    this.headerEl.className = CONFIG.CLASS_NAMES.HEADER;
    this.headerEl.innerHTML = `
      <div class="file-manager-title-group">
        <span class="file-manager-title">Artifacts</span>
        <span class="file-manager-count">0</span>
      </div>
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

      this._trackDOMListener(btn, 'click', () => this._handleFilterChange(filter));
      filterGroup.appendChild(btn);
    }

    this.controlsEl.appendChild(filterGroup);

    this.listEl = document.createElement('div');
    this.listEl.className = CONFIG.CLASS_NAMES.LIST;
    
    // Setup event delegation for file items and actions to support surgical DOM diffing
    this._trackDOMListener(this.listEl, 'click', (e) => {
      const exportBtn = e.target.closest('.file-action-export');
      if (exportBtn) {
        e.stopPropagation();
        this._handleActionClick('export', exportBtn.dataset.artifactId);
        return;
      }
      const editBtn = e.target.closest('.file-action-edit');
      if (editBtn) {
        e.stopPropagation();
        this._handleActionClick('edit', editBtn.dataset.artifactId);
        return;
      }
      const deleteBtn = e.target.closest('.file-action-delete');
      if (deleteBtn) {
        e.stopPropagation();
        this._handleActionClick('delete', deleteBtn.dataset.artifactId);
        return;
      }
      const itemEl = e.target.closest(`.${CONFIG.CLASS_NAMES.ITEM}`);
      if (itemEl && !e.target.closest('.file-item-actions')) {
        this._handleActionClick('select', itemEl.dataset.artifactId);
        return;
      }
    });

    this.container.appendChild(this.headerEl);
    this.container.appendChild(this.controlsEl);
    this.container.appendChild(this.listEl);
  }

  _handleActionClick(action, artifactId) {
    if (!artifactId) return;
    const artifact = this.artifacts.find(a => a.id === artifactId);
    if (!artifact) return;
    
    switch (action) {
      case 'export':
        this._handleExport(artifact);
        break;
      case 'edit':
        this._handleEdit(artifact);
        break;
      case 'delete':
        this._handleDelete(artifact);
        break;
      case 'select':
        this._handleFileClick(artifact);
        break;
    }
  }

  _setupEventListeners() {
    const cleanupChatSwitch = this.eventBus.on(EventTypes.ARTIFACTS.CHAT_SWITCHED, (data) => {
      if (this._isDisposed) return; // BUG FM-4 FIX
      this.log.debug('[FileManager] Chat switched event:', data);
      this.loadFiles(data.chatId);
    });
    this._eventListeners.push(cleanupChatSwitch);

    // Listen to ARTIFACT_FINALIZED for user-visible artifacts only
    // Backend sends multiple variants (assistant:code, computer:console, computer:code)
    // Only show meaningful artifacts to avoid clutter
    const cleanupArtifactFinalized = this.eventBus.on(EventTypes.ARTIFACTS.ARTIFACT_FINALIZED, (data) => {
      if (this._isDisposed) return; // BUG FM-4 FIX
      const artifactChatId = data.chatId || data.artifact?.chatId;
      
      // Auto-detect chat ID from first artifact if we don't have one yet
      if (!this.currentChatId && artifactChatId) {
        this.currentChatId = artifactChatId;
      }
      
      // Only process artifacts for current chat
      if (!this.currentChatId || artifactChatId !== this.currentChatId) {
        return;
      }

      // Debounce file manager updates (multiple variants arrive in quick succession)
      if (this._updateDebounceTimer) {
        clearTimeout(this._updateDebounceTimer);
      }
      
      this._updateDebounceTimer = setTimeout(() => {
        // Reload all artifacts to get proper grouping (more reliable than incremental updates)
        this.loadFiles(this.currentChatId);
      }, 300); // 300ms debounce - wait for all variants to arrive
    });
    this._eventListeners.push(cleanupArtifactFinalized);

    // Also listen to SESSION_SWITCHED event for session manager integration
    const cleanupSessionSwitch = this.eventBus.on(EventTypes.ARTIFACTS.SESSION_SWITCHED, (data) => {
      if (this._isDisposed) return; // BUG FM-4 FIX
      this.log.debug('[FileManager] Session switched event:', data);
      if (data.chatId) {
        this.loadFiles(data.chatId);
      }
    });
    this._eventListeners.push(cleanupSessionSwitch);
  }

  _updateDOM(parent, newElement) {
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
    morphChildren(parent, newElement);
  }

  _renderFiles() {
    const filteredGroups = this._applyFilter();

    if (filteredGroups.length === 0) {
      this._renderEmpty('No artifacts match filter');
      return;
    }

    this._updateCount(filteredGroups);

    const tempContainer = document.createElement('div');
    for (const group of filteredGroups) {
      const groupEl = this._buildGroupElement(group);
      tempContainer.appendChild(groupEl);
    }
    
    if (this.listEl.childNodes.length === 0 || this.listEl.querySelector(`.${CONFIG.CLASS_NAMES.EMPTY}`) || this.listEl.querySelector(`.${CONFIG.CLASS_NAMES.LOADING}`)) {
      this.listEl.innerHTML = '';
      this.listEl.appendChild(tempContainer);
      // Unwrap temp container
      while (tempContainer.firstChild) {
        this.listEl.appendChild(tempContainer.firstChild);
      }
      tempContainer.remove();
    } else {
      this._updateDOM(this.listEl, tempContainer);
    }
  }

  _applyFilter() {
    switch (this.currentFilter) {
      case 'code':
        return this.groups.filter(g => g.codeArtifacts.length > 0);
      
      case 'output':
        return this.groups.filter(g => g.outputArtifacts.length > 0);
      
      case 'attachment':
        return this.groups.filter(g => g.attachmentArtifacts.length > 0);
      
      case 'linked':
        return this.groups.filter(g => 
          g.codeArtifacts.length > 0 && g.outputArtifacts.length > 0
        );
      
      case 'all':
      default:
        return this.groups;
    }
  }

  _buildGroupElement(group) {
    const groupEl = document.createElement('div');
    groupEl.className = CONFIG.CLASS_NAMES.GROUP;

    const headerEl = document.createElement('div');
    headerEl.className = CONFIG.CLASS_NAMES.GROUP_HEADER;
    
    const isLinked = group.codeArtifacts.length > 0 && group.outputArtifacts.length > 0;
    const isAttachmentGroup = group.attachmentArtifacts.length > 0;
    
    let linkLabel;
    if (isAttachmentGroup) {
      linkLabel = 'Attachment';
    } else if (isLinked) {
      linkLabel = 'Execution Unit';
    } else {
      linkLabel = 'Partial Step';
    }
    
    // ARCHITECTURAL FIX: Show only user-visible files per filter
    // Execution groups show up to 2 files: code + output
    // Attachment groups show 1 file: the attachment itself
    let artifactsToRender;
    switch (this.currentFilter) {
      case 'code':
        artifactsToRender = group.codeArtifacts;
        break;
      case 'output':
        artifactsToRender = group.outputArtifacts;
        break;
      case 'attachment':
        artifactsToRender = group.attachmentArtifacts;
        break;
      case 'linked':
        // For linked filter, show only groups that have both code and output
        if (isLinked) {
          artifactsToRender = group.artifacts;
        } else {
          artifactsToRender = [];
        }
        break;
      case 'all':
      default:
        artifactsToRender = group.artifacts;
        break;
    }
    
    // Skip rendering empty groups
    if (artifactsToRender.length === 0) {
      return groupEl;
    }
    
    headerEl.innerHTML = `
      <span class="group-label">${linkLabel} ${this._getGroupIndex(group)}</span>
      <span class="group-badge">${artifactsToRender.length}</span>
    `;

    const itemsEl = document.createElement('div');
    itemsEl.className = CONFIG.CLASS_NAMES.GROUP_ITEMS;

    const sortedArtifacts = [...artifactsToRender].sort((a, b) => {
      const catA = this._getArtifactCategory(a);
      const catB = this._getArtifactCategory(b);
      const order = { code_written: 0, execution_output: 1, html_output: 2 };
      return (order[catA] || 99) - (order[catB] || 99);
    });

    for (const artifact of sortedArtifacts) {
      const itemEl = this._createItemElement(artifact, isLinked);
      itemsEl.appendChild(itemEl);
    }

    groupEl.appendChild(headerEl);
    groupEl.appendChild(itemsEl);
    return groupEl;
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
    const rawName = artifact.filename || this._generateName(artifact);
    const SecuritySanitizer = require('../../../shared/security/SecuritySanitizer');
    const sanitizer = new SecuritySanitizer();
    const name = sanitizer.escapeHTML(rawName);
    const meta = this._generateMeta(artifact);

    itemEl.innerHTML = `
      <span class="${CONFIG.CLASS_NAMES.ITEM_ICON}">${icon}</span>
      <span class="${CONFIG.CLASS_NAMES.ITEM_NAME}">${name}</span>
      <span class="${CONFIG.CLASS_NAMES.ITEM_META}">${meta}</span>
      <div class="file-item-actions">
        <button class="file-action-btn file-action-export" title="Export" data-artifact-id="${artifact.id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>
        <button class="file-action-btn file-action-edit" title="Edit" data-artifact-id="${artifact.id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="file-action-btn file-action-delete" title="Delete" data-artifact-id="${artifact.id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </button>
      </div>
    `;

    return itemEl;
  }

  _getCategoryIcon(category) {
    switch (category) {
      case 'code':
      case 'code_written': 
        return CONFIG.CATEGORIES.CODE.icon;
      case 'output':
      case 'execution_output': 
      case 'html_output':
        return CONFIG.CATEGORIES.OUTPUT.icon;
      case 'console':
      case 'execution_console': 
        return CONFIG.CATEGORIES.CONSOLE.icon;
      case 'attachment':
      case 'file':
        return CONFIG.CATEGORIES.ATTACHMENT.icon;
      default: 
        return CONFIG.CATEGORIES.OUTPUT.icon;
    }
  }

  _generateName(artifact) {
    const category = this._getArtifactCategory(artifact);
    
    if (artifact.filename) return artifact.filename;

    switch (category) {
      case 'code': return 'source_code';
      case 'output': return 'execution_result';
      case 'attachment': return 'attachment';
      default: return 'artifact';
    }
  }

  _generateMeta(artifact) {
    const size = artifact.content?.length || 0;
    const sizeStr = size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
    const format = (artifact.format || artifact.language || 'txt').toUpperCase();
    return `${format} • ${sizeStr}`;
  }

  _getGroupIndex(group) {
    const execGroup = group.executionGroup || '';
    
    // Extract sequence number from execution group (e.g. exec_abcd_1 -> 1)
    if (execGroup.startsWith('exec_')) {
      const parts = execGroup.split('_');
      if (parts.length >= 3) {
        const seq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(seq)) {
          return seq;
        }
      }
    }
    
    // Fallback to position-based index
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
    this.log.debug('[FileManager] _handleFileClick START', {
      artifactId: artifact.id.substring(0, 8),
      filename: artifact.filename,
      type: artifact.type,
      role: artifact.role,
      hasController: !!this.controller,
      hasLoadArtifactMethod: !!(this.controller && typeof this.controller.loadArtifact === 'function'),
      timestamp: Date.now()
    });

    // Update selection state
    this.selectedArtifactId = artifact.id;

    // Update UI active state
    const items = this.listEl.querySelectorAll(`.${CONFIG.CLASS_NAMES.ITEM}`);
    items.forEach(item => {
      if (item.dataset.artifactId === artifact.id) {
        item.classList.add(CONFIG.CLASS_NAMES.ACTIVE);
        this.log.debug('[FileManager] Added active class to item', {
          artifactId: artifact.id.substring(0, 8)
        });
      } else {
        item.classList.remove(CONFIG.CLASS_NAMES.ACTIVE);
      }
    });

    // Emit event
    this.log.debug('[FileManager] Emitting FILE_SELECTED event', {
      artifactId: artifact.id.substring(0, 8),
      hasEventBus: !!this.eventBus
    });
    this.eventBus.emit(EventTypes.ARTIFACTS.FILE_SELECTED, { artifact });

    // SPECIAL HANDLING: Attachments (type: 'file') open differently
    // They should trigger a file viewer modal, not load in code/output viewers
    if (artifact.type === 'file') {
      this.log.debug('[FileManager] Opening attachment in file viewer', {
        artifactId: artifact.id.substring(0, 8),
        filename: artifact.filename || artifact.title
      });
      
      // Emit event to open file viewer (same pattern as ChatFilesModal)
      this.eventBus.emit('artifacts:open-file', {
        artifactId: artifact.id || artifact.artifact_id,
        filename: artifact.filename || artifact.title,
        content: artifact.content,
        type: artifact.type,
        metadata: artifact.metadata
      });
      return;
    }

    // Load code/output artifacts in controller
    if (this.controller && typeof this.controller.loadArtifact === 'function') {
      this.log.debug('[FileManager] Calling controller.loadArtifact', {
        artifactId: artifact.id.substring(0, 8),
        autoSwitch: true,
        origin: 'file-click'
      });
      
      try {
        this.controller.loadArtifact(artifact, { 
          autoSwitch: true, 
          origin: 'file-click' 
        });
        
        this.log.debug('[FileManager] controller.loadArtifact called successfully', {
          artifactId: artifact.id.substring(0, 8)
        });
      } catch (error) {
        this.log.error('[FileManager] controller.loadArtifact FAILED', {
          artifactId: artifact.id.substring(0, 8),
          error: error.message,
          stack: error.stack
        });
      }
    } else {
      this.log.error('[FileManager] Controller or loadArtifact method not available', {
        hasController: !!this.controller,
        controllerType: this.controller ? this.controller.constructor.name : 'undefined',
        hasLoadArtifactMethod: !!(this.controller && typeof this.controller.loadArtifact === 'function')
      });
    }

    this.log.debug('[FileManager] _handleFileClick END', {
      artifactId: artifact.id.substring(0, 8),
      timestamp: Date.now()
    });
  }

  highlightArtifact(artifactId) {
    if (this._isDisposed) return; // BUG FM-4 FIX
    this.log.debug('[FileManager] highlightArtifact START', {
      artifactId: artifactId?.substring(0, 8),
      currentSelectedId: this.selectedArtifactId?.substring(0, 8),
      timestamp: Date.now()
    });

    const startTime = Date.now();
    this.selectedArtifactId = artifactId;

    const items = this.listEl.querySelectorAll(`.${CONFIG.CLASS_NAMES.ITEM}`);
    this.log.debug('[FileManager] Found items to update', {
      itemCount: items.length,
      artifactId: artifactId?.substring(0, 8)
    });

    let highlightedCount = 0;
    let scrolledToItem = false;

    items.forEach(item => {
      if (item.dataset.artifactId === artifactId) {
        item.classList.add(CONFIG.CLASS_NAMES.ACTIVE);
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        highlightedCount++;
        scrolledToItem = true;
        this.log.debug('[FileManager] Highlighted and scrolled to item', {
          artifactId: artifactId.substring(0, 8)
        });
      } else {
        item.classList.remove(CONFIG.CLASS_NAMES.ACTIVE);
      }
    });

    const duration = Date.now() - startTime;
    this.log.debug('[FileManager] highlightArtifact COMPLETE', {
      artifactId: artifactId?.substring(0, 8),
      highlightedCount,
      scrolledToItem,
      itemCount: items.length,
      duration: duration + 'ms'
    });
  }

  _renderLoading() {
    // BUG FM-9 FIX: Clean item listeners before innerHTML wipe (matches _renderFiles pattern)
    this._cleanupItemListeners();
    this.listEl.innerHTML = `<div class="${CONFIG.CLASS_NAMES.LOADING}">Loading artifacts...</div>`;
  }

  _renderEmpty(message) {
    // BUG FM-9 FIX: Clean item listeners before DOM replacement (matches _renderFiles pattern)
    this._cleanupItemListeners();
    // BUG FM-7 FIX: Use textContent instead of innerHTML for defense-in-depth against XSS
    this.listEl.innerHTML = '';
    const emptyDiv = document.createElement('div');
    emptyDiv.className = CONFIG.CLASS_NAMES.EMPTY;
    emptyDiv.textContent = message;
    this.listEl.appendChild(emptyDiv);
  }

  _renderError(error) {
    // BUG FM-2 FIX: Use textContent instead of innerHTML to prevent XSS from error messages
    this._cleanupItemListeners();
    this.listEl.innerHTML = '';
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding: 16px; color: var(--color-error);';
    errorDiv.textContent = error.message;
    this.listEl.appendChild(errorDiv);
  }

  async _handleExport(artifact) {
    this.log.debug('[FileManager] Exporting artifact:', artifact.id);
    
    try {
      // Use the artifact's PostgreSQL UUID for filename
      const artifactId = artifact.postgresqlId || artifact.id;
      
      // Use artifact content directly (already loaded)
      const response = artifact.content || '';
      
      // Create download link
      const blob = new Blob([response], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = artifact.filename || `artifact_${artifactId}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.log.debug('[FileManager] Artifact exported successfully');
      
      this.eventBus.emit(EventTypes.UI.NOTIFICATION, {
        type: 'success',
        message: 'Artifact exported successfully'
      });
      
    } catch (error) {
      this.log.error('[FileManager] Failed to export artifact:', error);
      this.eventBus.emit(EventTypes.UI.ERROR, {
        message: 'Failed to export artifact',
        error
      });
    }
  }

  async _handleEdit(artifact) {
    this.log.debug('[FileManager] Editing artifact:', artifact.id);
    
    try {
      // Create modal for editing
      const newContent = await this._showEditModal(artifact);
      if (this._isDisposed) return;
      
      if (newContent === null) {
        // User cancelled
        return;
      }
      
      if (!this.storageAPI) {
        throw new Error('StorageAPI not available');
      }

      // CRITICAL: Use PostgreSQL UUID for backend operations
      // The backend DELETE/UPDATE endpoints expect the database UUID, not the frontend artifact_id
      const artifactId = artifact.postgresqlId || artifact.id;
      
      this.log.debug('[FileManager] Updating artifact:', { 
        artifactId, 
        postgresqlId: artifact.postgresqlId,
        frontendId: artifact.artifactId,
        contentLength: newContent.length,
        hasStorageAPI: !!this.storageAPI,
        hasClient: !!(this.storageAPI && this.storageAPI.client)
      });
      
      // Use storageAPI's client directly
      if (!this.storageAPI.client) {
        throw new Error('StorageAPI client not initialized');
      }
      
      // Update via storageAPI HTTP client - backend expects ArtifactUpdate schema
      const updated = await this.storageAPI.client.put(`/artifacts/${artifactId}`, {
        content: newContent
      });
      if (this._isDisposed) return;
      
      this.log.debug('[FileManager] Update response:', updated);
      
      this.log.debug('[FileManager] Artifact updated successfully');
      
      // Update local artifact
      artifact.content = newContent;
      
      // Reload files to reflect changes
      await this.loadFiles(this.currentChatId);
      if (this._isDisposed) return;
      
      this.eventBus.emit(EventTypes.UI.NOTIFICATION, {
        type: 'success',
        message: 'Artifact updated successfully'
      });
      
    } catch (error) {
      this.log.error('[FileManager] Failed to update artifact:', error);
      this.eventBus.emit(EventTypes.UI.ERROR, {
        message: 'Failed to update artifact',
        error
      });
    }
  }

  /**
   * Show modal dialog for editing artifact content
   * @private
   * @param {Object} artifact - Artifact to edit
   * @returns {Promise<string|null>} New content or null if cancelled
   */
  _showEditModal(artifact) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay is-visible file-manager-modal-overlay';
      overlay.setAttribute('role', 'presentation');

      const panel = document.createElement('div');
      panel.className = 'modal-panel file-manager-modal file-manager-edit-modal';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');

      const header = document.createElement('div');
      header.className = 'modal-header';

      const title = document.createElement('h3');
      title.className = 'modal-title';
      title.textContent = `Edit: ${artifact.filename || 'Untitled'}`;

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'modal-close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = '×';

      header.appendChild(title);
      header.appendChild(closeBtn);

      const body = document.createElement('div');
      body.className = 'modal-body';

      const textarea = document.createElement('textarea');
      textarea.className = 'textarea file-manager-edit-textarea';
      textarea.value = artifact.content || '';
      textarea.setAttribute('spellcheck', 'false');
      body.appendChild(textarea);

      const footer = document.createElement('div');
      footer.className = 'modal-footer';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-secondary';
      cancelBtn.textContent = 'Cancel';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-primary';
      saveBtn.textContent = 'Save';

      footer.appendChild(cancelBtn);
      footer.appendChild(saveBtn);

      panel.appendChild(header);
      panel.appendChild(body);
      panel.appendChild(footer);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      const transitionMs = (() => {
        try {
          const raw = getComputedStyle(overlay).transitionDuration || '';
          const first = raw.split(',')[0]?.trim() || '0s';
          const seconds = first.endsWith('ms')
            ? Number(first.slice(0, -2)) / 1000
            : Number(first.replace('s', ''));
          return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0;
        } catch {
          return 0;
        }
      })();

      let resolved = false;
      const teardown = () => {
        if (resolved) return;
        resolved = true;
        this._activeModalTeardown = null; // BUG FM-3 FIX: Clear tracked reference
        document.removeEventListener('keydown', onKeydown);
        overlay.removeEventListener('click', onOverlayClick);
        cancelBtn.removeEventListener('click', onCancel);
        saveBtn.removeEventListener('click', onSave);
        closeBtn.removeEventListener('click', onCancel);
      };

      const removeOverlay = () => {
        overlay.remove();
      };

      const closeWith = (value) => {
        teardown();
        overlay.classList.remove('is-visible');
        // Deterministic teardown: avoid transitionend memory leaks
        if (transitionMs > 0) {
          setTimeout(removeOverlay, transitionMs + 50);
        } else {
          removeOverlay();
        }
        resolve(value);
      };

      const onCancel = () => closeWith(null);
      const onSave = () => closeWith(textarea.value);

      const onOverlayClick = (e) => {
        if (e.target === overlay) {
          closeWith(null);
        }
      };

      const onKeydown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeWith(null);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          closeWith(textarea.value);
        }
      };

      cancelBtn.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      saveBtn.addEventListener('click', onSave);
      overlay.addEventListener('click', onOverlayClick);
      document.addEventListener('keydown', onKeydown);

      // BUG FM-3 FIX: Track teardown so dispose() can close open modals
      this._activeModalTeardown = () => closeWith(null);

      // Focus textarea on next frame for consistent caret placement
      requestAnimationFrame(() => {
        try {
          textarea.focus();
          textarea.select();
        } catch (e) { this.log.trace('[FileManager] Rename textarea focus failed:', e?.message); }
      });
    });
  }

  async _handleDelete(artifact) {
    this.log.debug('[FileManager] Deleting artifact:', artifact.id);
    
    try {
      // Use custom confirmation dialog instead of confirm()
      const confirmed = await this._showConfirmDialog(
        'Delete Artifact',
        `Are you sure you want to delete "${artifact.filename || 'Untitled'}"?`,
        'This action cannot be undone.'
      );
      if (this._isDisposed) return;
      
      if (!confirmed) {
        return;
      }
      
      if (!this.storageAPI || !this.storageAPI.deleteArtifact) {
        throw new Error('StorageAPI not available');
      }

      // CRITICAL: Use PostgreSQL UUID for backend operations
      // The backend DELETE/UPDATE endpoints expect the database UUID, not the frontend artifact_id
      const artifactId = artifact.postgresqlId || artifact.id;
      
      this.log.debug('[FileManager] Deleting artifact:', {
        artifactId,
        postgresqlId: artifact.postgresqlId,
        frontendId: artifact.artifactId
      });
      await this.storageAPI.deleteArtifact(artifactId);
      if (this._isDisposed) return;
      this.log.debug('[FileManager] Delete successful');
      
      this.log.debug('[FileManager] Artifact deleted successfully');
      
      // Emit deletion event for trail nodes and artifact cache
      this.eventBus.emit(EventTypes.ARTIFACTS.FILE_DELETED, {
        artifactId: artifact.id,
        postgresqlId: artifactId,
        frontendId: artifact.artifactId,
        filename: artifact.filename || 'Untitled'
      });
      
      // Remove from local artifacts array
      const index = this.artifacts.findIndex(a => a.id === artifact.id);
      if (index !== -1) {
        this.artifacts.splice(index, 1);
      }
      
      // Re-group and re-render (BUG FM-5 FIX: _groupArtifacts already returns Array)
      this.groups = this._groupArtifacts(this.artifacts);
      this._renderFiles();
      
      this.eventBus.emit(EventTypes.UI.NOTIFICATION, {
        type: 'success',
        message: 'Artifact deleted successfully'
      });
      
    } catch (error) {
      this.log.error('[FileManager] Failed to delete artifact:', error);
      this.eventBus.emit(EventTypes.UI.ERROR, {
        message: 'Failed to delete artifact',
        error
      });
    }
  }

  /**
   * Show confirmation dialog
   * @private
   * @param {string} title - Dialog title
   * @param {string} message - Main message
   * @param {string} detail - Detail text
   * @returns {Promise<boolean>} True if confirmed, false if cancelled
   */
  _showConfirmDialog(title, message, detail = '') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay is-visible file-manager-modal-overlay';
      overlay.setAttribute('role', 'presentation');

      const panel = document.createElement('div');
      panel.className = 'modal-panel file-manager-modal file-manager-confirm-modal';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');

      const header = document.createElement('div');
      header.className = 'modal-header';

      const titleEl = document.createElement('h3');
      titleEl.className = 'modal-title';
      titleEl.textContent = title;

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'modal-close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = '×';

      header.appendChild(titleEl);
      header.appendChild(closeBtn);

      const body = document.createElement('div');
      body.className = 'modal-body file-manager-confirm-body';

      const messageEl = document.createElement('p');
      messageEl.className = 'file-manager-confirm-message';
      messageEl.textContent = message;
      body.appendChild(messageEl);

      if (detail) {
        const detailEl = document.createElement('p');
        detailEl.className = 'file-manager-confirm-detail';
        detailEl.textContent = detail;
        body.appendChild(detailEl);
      }

      const footer = document.createElement('div');
      footer.className = 'modal-footer';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-secondary';
      cancelBtn.textContent = 'Cancel';

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'btn btn-danger';
      confirmBtn.textContent = 'Delete';

      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);

      panel.appendChild(header);
      panel.appendChild(body);
      panel.appendChild(footer);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      const transitionMs = (() => {
        try {
          const raw = getComputedStyle(overlay).transitionDuration || '';
          const first = raw.split(',')[0]?.trim() || '0s';
          const seconds = first.endsWith('ms')
            ? Number(first.slice(0, -2)) / 1000
            : Number(first.replace('s', ''));
          return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0;
        } catch {
          return 0;
        }
      })();

      let resolved = false;
      const teardown = () => {
        if (resolved) return;
        resolved = true;
        this._activeModalTeardown = null; // BUG FM-3 FIX: Clear tracked reference
        document.removeEventListener('keydown', onKeydown);
        overlay.removeEventListener('click', onOverlayClick);
        cancelBtn.removeEventListener('click', onCancel);
        confirmBtn.removeEventListener('click', onConfirm);
        closeBtn.removeEventListener('click', onCancel);
      };

      const removeOverlay = () => {
        overlay.remove();
      };

      const closeWith = (value) => {
        teardown();
        overlay.classList.remove('is-visible');
        if (transitionMs > 0) {
          setTimeout(removeOverlay, transitionMs + 50);
        } else {
          removeOverlay();
        }
        resolve(value);
      };

      const onCancel = () => closeWith(false);
      const onConfirm = () => closeWith(true);
      const onOverlayClick = (e) => {
        if (e.target === overlay) {
          closeWith(false);
        }
      };
      const onKeydown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeWith(false);
        }
      };

      cancelBtn.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      confirmBtn.addEventListener('click', onConfirm);
      overlay.addEventListener('click', onOverlayClick);
      document.addEventListener('keydown', onKeydown);

      // BUG FM-3 FIX: Track teardown so dispose() can close open modals
      this._activeModalTeardown = () => closeWith(false);
    });
  }

  _injectStyles() {
    // Styles must be centralized in CSS (renderer/artifacts/styles/artifacts.css),
    // not injected at runtime. Keep this method as a no-op to avoid regressions
    // from legacy call sites.
    return;
  }
}

module.exports = FileManager;

if (typeof window !== 'undefined') {
  window.FileManager = FileManager;
}
