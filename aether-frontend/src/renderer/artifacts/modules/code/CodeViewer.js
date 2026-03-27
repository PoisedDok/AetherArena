'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController (loadCode method), IPC 'artifacts:load-code' events, window.hljs/window.ace --- {artifact_types.code_artifact, json}
 * Processing: Create tab-based UI, lazy load ACE editor & Highlight.js, render syntax highlighted code, manage editor tabs, handle copy/export actions --- {5 jobs: JOB_CREATE_DOM_ELEMENT, JOB_GET_STATE, JOB_UPDATE_DOM_ELEMENT, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT}
 * Outgoing: DOM (code editor with syntax highlighting), ArtifactsController.exportFile(), EventBus --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/code/CodeViewer
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const { createRendererLogger } = require('../../../shared/utils/logger');
const { freeze } = Object;
const CodeTabsManager = require('./CodeTabsManager');
const CodeViewRenderer = require('./CodeViewRenderer');

// Code viewer configuration
const CONFIG = freeze({
  CODE: freeze({
    MAX_TABS: 20,
    DEFAULT_LANGUAGE: 'text',
    DEFAULT_THEME: 'monokai',
    TAB_SIZE: 2,
    WRAP: true,
    SHOW_LINE_NUMBERS: true,
    SHOW_GUTTER: true,
    HIGHLIGHT_ACTIVE_LINE: true,
    ENABLE_LIVE_AUTOCOMPLETION: true,
  }),
  CLASS_NAMES: freeze({
    CONTAINER: 'code-viewer-container',
    TABS_HEADER: 'code-tabs-header',
    TABS_CONTENT: 'code-tabs-content',
    TAB_BUTTON: 'code-tab-button',
    TAB_LABEL: 'code-tab-label',
    TAB_CLOSE: 'code-tab-close',
    TAB_CONTENT: 'code-tab-content',
    ACTIVE_TAB: 'active',
    CODE_CONTROLS: 'code-controls',
    CODE_EDITOR: 'code-editor',
    CODE_DISPLAY: 'code-display',
    LINE_NUMBERS: 'line-numbers',
    CODE_LINES: 'code-lines',
  }),
  SUPPORTED_LANGUAGES: freeze([
    'javascript', 'js', 'typescript', 'ts',
    'python', 'py', 'java', 'c', 'cpp', 'csharp', 'cs',
    'html', 'css', 'scss', 'sass', 'less',
    'json', 'xml', 'yaml', 'yml',
    'markdown', 'md', 'sql',
    'shell', 'bash', 'sh', 'zsh',
    'ruby', 'rb', 'php', 'go', 'rust', 'swift', 'kotlin',
    'text', 'txt', 'plaintext',
  ]),
});

class CodeViewer {
  /**
   * Create code viewer
   * @param {Object} options - Configuration options
   * @param {Object} options.controller - Artifacts controller instance
   * @param {Object} options.eventBus - Event bus for communication
   */
  constructor(options = {}) {
    this.log = createRendererLogger('CodeViewer');
    if (!options.controller) {
      throw new Error('[CodeViewer] Controller required');
    }

    if (!options.eventBus) {
      throw new Error('[CodeViewer] EventBus required');
    }

    this.controller = options.controller;
    this.eventBus = options.eventBus;
    this.aether = options.aether || getAether();

    // DOM elements
    this.container = null;
    this.tabsHeader = null;
    this.tabsContent = null;

    // Managers
    this.tabsManager = new CodeTabsManager(CONFIG.CODE.MAX_TABS);
    this.renderer = new CodeViewRenderer(CONFIG, this.log);

    // Event handlers (for cleanup)
    this._eventListeners = [];
    this._tabListeners = new Map(); // BUG CV-4 FIX: Per-tab listener tracking for cleanup on closeTab
    this._initialized = false; // BUG CV-3 FIX: Idempotency guard for init()
    this._isDisposed = false; // Robustness guard against post-dispose operations
    this._resizeTimerId = null; // BUG CV-2 FIX: Track resize setTimeout in setActiveTab

    // Phase 1: Stream Buffering
    this._streamBuffer = new Map(); // tabId -> latest chunk data
    this._rafIds = new Map(); // tabId -> rafId
    this._isStreaming = new Map(); // tabId -> boolean

    // Bind methods
    this._handleTabClick = this._handleTabClick.bind(this);
    this._handleTabClose = this._handleTabClose.bind(this);
    this._handleCopyCode = this._handleCopyCode.bind(this);
    this._handleExportCode = this._handleExportCode.bind(this);
  }

  get tabs() {
    return this.tabsManager.tabs;
  }

  get activeTabId() {
    return this.tabsManager.activeTabId;
  }

  set activeTabId(id) {
    this.tabsManager.activeTabId = id;
  }

  get tabCounter() {
    return this.tabsManager.tabCounter;
  }

  set tabCounter(val) {
    this.tabsManager.tabCounter = val;
  }

  /**
   * Initialize code viewer
   * @param {HTMLElement} container - Container pane element
   */
  async init(container) {
    // BUG CV-9 FIX: Prevent zombie resurrection after dispose
    if (this._isDisposed) return;
    // BUG CV-3 FIX: Prevent duplicate DOM on repeated init() calls
    if (this._initialized) return;
    this.log.debug('CodeViewer: Initializing...');

    try {
      if (!container) {
        throw new Error('[CodeViewer] Container required');
      }

      this.container = container;

      // Create DOM structure
      const dom = this.renderer.createStructure(this.container);
      this.tabsHeader = dom.tabsHeader;
      this.tabsContent = dom.tabsContent;

      // Inject styles
      this.renderer.injectStyles();

      // Load libraries (async)
      this.renderer.loadLibraries(this.aether);

      // Hide tabs header (not needed - each code is individual)
      if (this.tabsHeader) {
        this.tabsHeader.style.display = 'none';
      }

      this._initialized = true; // BUG CV-3 FIX: Mark initialized

      if (this.tabsManager.count === 0) {
        this.createTab('Code 1', '', CONFIG.CODE.DEFAULT_LANGUAGE);
      }

      // Emit ready event
      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'CodeViewer',
        timestamp: Date.now()
      });

      this.log.debug('CodeViewer: Initialized');

    } catch (error) {
      this.log.error('CodeViewer: Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Dispose code viewer and cleanup
   */
  dispose() {
    if (this._isDisposed) return; // Idempotent
    this.log.debug('CodeViewer: Disposing...');
    this._isDisposed = true;

    // BUG CV-2 FIX: Clear tracked resize timer
    if (this._resizeTimerId !== null) {
      clearTimeout(this._resizeTimerId);
      this._resizeTimerId = null;
    }

    // Dispose ACE editors
    for (const tab of this.tabsManager.getAllTabs()) {
      if (tab.editor) {
        try {
          tab.editor.destroy();
        } catch (error) {
          this.log.error('[CodeViewer] Failed to destroy editor:', error);
        }
      }
    }

    // Clear tabs
    this.tabsManager.clear();

    // BUG CV-4 FIX: Clean per-tab listeners
    for (const cleanups of this._tabListeners.values()) {
      for (const cleanup of cleanups) {
        try { cleanup(); } catch (_) { /* element may already be gone */ }
      }
    }
    this._tabListeners.clear();

    // Remove global event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('[CodeViewer] Failed to cleanup event listener:', error);
      }
    }
    this._eventListeners = [];

    // BUG CV-1 FIX + CV-8 FIX: Only remove style element when last instance disposes
    this.renderer.removeStyles();

    // Clear references
    this.container = null;
    this.tabsHeader = null;
    this.tabsContent = null;
    this._initialized = false;

    this.log.debug('CodeViewer: Disposed');
  }

  /**
   * Create a new tab
   * @param {string} label - Tab label
   * @param {string} code - Initial code content
   * @param {string} language - Programming language
   * @returns {string} Tab ID
   */
  createTab(label, code = '', language = CONFIG.CODE.DEFAULT_LANGUAGE, artifactId = null) {
    // BUG CV-5 FIX: Guard against post-dispose calls (tabsHeader is null after dispose)
    if (this._isDisposed) {
      this.log.warn('[CodeViewer] createTab called after dispose');
      return null;
    }

    const normalizedCode = this._normalizeCodeInput(code);
    const normalizedLanguage = this._normalizeLanguageInput(language);

    if (this.tabsManager.count >= CONFIG.CODE.MAX_TABS) {
      this.log.warn('[CodeViewer] Maximum tabs reached');
      this.eventBus.emit(EventTypes.UI.ERROR, { 
        message: 'Maximum code tabs reached',
        limit: CONFIG.CODE.MAX_TABS
      });
      return null;
    }

    const tabId = this.tabsManager.generateTabId();

    // BUG CV-4 FIX: Initialize per-tab listener tracking before creating sub-elements
    this._tabListeners.set(tabId, []);

    // Create tab button
    const { button, closeBtn } = this.renderer.createTabButton(tabId, label);
    this.tabsHeader.appendChild(button);

    // Create tab content
    const content = this.renderer.createTabContent(tabId, this.tabsContent);

    // Create editor or display
    const { editor, editorEl, codeEl } = this.renderer.createEditor(content, normalizedCode, normalizedLanguage);

    const displayName = this._getLanguageDisplayName(normalizedLanguage);
    const { controls, copyBtn, exportBtn, langBadge } = this.renderer.createControls(content, displayName);
    content.insertBefore(controls, editorEl);

    // Add event listeners
    const handleClick = (e) => {
      if (!e.target.matches(`.${CONFIG.CLASS_NAMES.TAB_CLOSE}`)) {
        this._handleTabClick(tabId);
      }
    };
    const handleClose = (e) => {
      e.stopPropagation();
      this._handleTabClose(tabId);
    };
    button.addEventListener('click', handleClick);
    closeBtn.addEventListener('click', handleClose);

    copyBtn.addEventListener('click', this._handleCopyCode);
    exportBtn.addEventListener('click', this._handleExportCode);

    const controlCleanup = () => {
      button.removeEventListener('click', handleClick);
      closeBtn.removeEventListener('click', handleClose);
      copyBtn.removeEventListener('click', this._handleCopyCode);
      exportBtn.removeEventListener('click', this._handleExportCode);
    };

    const tabCleanups = this._tabListeners.get(tabId);
    if (tabCleanups) {
      tabCleanups.push(controlCleanup);
    } else {
      this._eventListeners.push(controlCleanup);
    }

    // Store tab
    this.tabsManager.tabs.set(tabId, {
      id: tabId,
      label,
      button,
      content,
      editor,
      language: normalizedLanguage,
      code: normalizedCode,
      artifactId,
    });

    // Set as active
    this.setActiveTab(tabId);

    // Emit event
    this.eventBus.emit(EventTypes.ARTIFACTS.CODE_TAB_CREATED, { 
      tabId,
      label,
      language: normalizedLanguage,
      timestamp: Date.now()
    });

    this.log.debug(`[CodeViewer] Created tab: ${tabId}`);

    return tabId;
  }

  /**
   * Close a tab
   * @param {string} tabId - Tab ID to close
   */
  closeTab(tabId) {
    // BUG CV-5 FIX: Guard against post-dispose calls
    if (this._isDisposed) return;

    const tab = this.tabsManager.tabs.get(tabId);
    if (!tab) {
      this.log.warn(`[CodeViewer] Tab not found: ${tabId}`);
      return;
    }

    // Destroy editor
    if (tab.editor) {
      try {
        tab.editor.destroy();
      } catch (error) {
        this.log.error('[CodeViewer] Failed to destroy editor:', error);
      }
    }

    // BUG CV-4 FIX: Clean per-tab listeners BEFORE removing DOM
    const tabCleanups = this._tabListeners.get(tabId);
    if (tabCleanups) {
      for (const cleanup of tabCleanups) {
        try { cleanup(); } catch (_) { /* element may already be gone */ }
      }
      this._tabListeners.delete(tabId);
    }

    // Clear RAF and buffer state for this tab
    if (this._rafIds.has(tabId)) {
      cancelAnimationFrame(this._rafIds.get(tabId));
      this._rafIds.delete(tabId);
    }
    this._streamBuffer.delete(tabId);
    this._isStreaming.delete(tabId);

    // Remove DOM elements
    if (tab.button && tab.button.parentNode) {
      tab.button.parentNode.removeChild(tab.button);
    }
    if (tab.content && tab.content.parentNode) {
      tab.content.parentNode.removeChild(tab.content);
    }

    // Remove from tabs
    this.tabsManager.tabs.delete(tabId);

    // If closing active tab, activate another tab
    if (this.activeTabId === tabId) {
      if (this.tabsManager.tabs.size > 0) {
        const firstTabId = this.tabsManager.tabs.keys().next().value;
        this.setActiveTab(firstTabId);
      } else {
        // Create new default tab if all closed
        this.createTab('Code 1', '', CONFIG.CODE.DEFAULT_LANGUAGE);
      }
    }

    // Emit event
    this.eventBus.emit(EventTypes.ARTIFACTS.CODE_TAB_CLOSED, { 
      tabId,
      timestamp: Date.now()
    });

    this.log.debug(`[CodeViewer] Closed tab: ${tabId}`);
  }

  /**
   * Set active tab
   * @param {string} tabId - Tab ID to activate
   */
  setActiveTab(tabId) {
    // BUG CV-5 FIX: Guard against post-dispose calls
    if (this._isDisposed) return;

    if (!this.tabsManager.tabs.has(tabId)) {
      this.log.warn(`[CodeViewer] Tab not found: ${tabId}`);
      return;
    }

    // Deactivate all tabs
    for (const [id, tab] of this.tabsManager.tabs) {
      tab.button.classList.remove(CONFIG.CLASS_NAMES.ACTIVE_TAB);
      tab.content.classList.remove(CONFIG.CLASS_NAMES.ACTIVE_TAB);
    }

    // Activate target tab
    const tab = this.tabsManager.tabs.get(tabId);
    tab.button.classList.add(CONFIG.CLASS_NAMES.ACTIVE_TAB);
    tab.content.classList.add(CONFIG.CLASS_NAMES.ACTIVE_TAB);

    // Update state
    this.activeTabId = tabId;

    // BUG CV-2 FIX: Track resize timer and guard callback against disposed state
    if (tab.editor && tab.editor.resize) {
      if (this._resizeTimerId !== null) {
        clearTimeout(this._resizeTimerId);
      }
      this._resizeTimerId = setTimeout(() => {
        this._resizeTimerId = null;
        if (!this._isDisposed && tab.editor) {
          tab.editor.resize();
        }
      }, 100);
    }

    // Emit event
    this.eventBus.emit(EventTypes.ARTIFACTS.CODE_TAB_CHANGED, { 
      tabId,
      language: tab.language,
      timestamp: Date.now()
    });

    this.log.debug(`[CodeViewer] Active tab: ${tabId}`);
  }

  /**
   * Queue code chunk into stream buffer
   * @param {string} code - Code content
   * @param {string} language - Programming language
   * @param {string} filename - Optional filename
   * @param {string} artifactId - Optional artifact ID
   */
  loadCode(code, language = CONFIG.CODE.DEFAULT_LANGUAGE, filename = null, artifactId = null) {
    if (this._isDisposed) return;

    // We buffer the load state against the active or target tab ID
    let targetTabId = this.activeTabId;

    // FAIL FAST: Check if we are updating an existing artifact tab
    if (artifactId) {
      for (const [tabId, tab] of this.tabsManager.tabs.entries()) {
        if (tab.artifactId === artifactId) {
          targetTabId = tabId;
          break;
        }
      }
    }

    if (!targetTabId && this.tabsManager.tabs.size === 0) {
      // Must create a new tab synchronously if none exist so we have a target
      const label = filename || `Code ${this.tabsManager.tabCounter + 1}`;
      targetTabId = this.createTab(label, '', language, artifactId);
    } else if (!targetTabId && this.tabsManager.tabs.size > 0) {
      targetTabId = Array.from(this.tabsManager.tabs.keys())[0];
    }

    if (!targetTabId) return;

    // Buffer the latest state
    this._streamBuffer.set(targetTabId, { code, language, filename, artifactId });

    if (!this._isStreaming.get(targetTabId)) {
      this._isStreaming.set(targetTabId, true);
      // Wait for next RAF, but also allow forced synchronous flush for tests
      const flush = () => this._flushStreamBuffer(targetTabId);
      if (typeof process !== 'undefined' && process.env.JEST_WORKER_ID) {
        // Fast-path for jest tests to avoid async headaches
        flush();
      } else {
        this._rafIds.set(targetTabId, requestAnimationFrame(flush));
      }
    }
  }

  /**
   * Phase 1: Flush stream buffer via RAF
   * @private
   */
  _flushStreamBuffer(tabId) {
    if (this._isDisposed) return;
    
    this._isStreaming.set(tabId, false);
    const latest = this._streamBuffer.get(tabId);
    if (!latest) return;
    
    this._streamBuffer.delete(tabId);
    this._renderCode(tabId, latest.code, latest.language, latest.filename, latest.artifactId);
  }

  /**
   * Core code rendering logic (previously loadCode)
   * ARCHITECTURAL FIX: Reuse active tab during streaming to prevent horizontal duplication
   * @param {string} tabId - Target tab ID
   * @param {string} code - Code content
   * @param {string} language - Programming language
   * @param {string} filename - Optional filename
   * @param {string} artifactId - Optional artifact ID
   */
  _renderCode(tabId, code, language = CONFIG.CODE.DEFAULT_LANGUAGE, filename = null, artifactId = null) {
    // BUG CV-5 FIX: Guard against post-dispose calls
    if (this._isDisposed) return;

    const normalizedCode = this._normalizeCodeInput(code);
    const normalizedLanguage = this._normalizeLanguageInput(language);

    const tab = this.tabsManager.tabs.get(tabId);
    if (!tab) return;

    // If updating an existing artifact, check if content changed
    if (artifactId && tab.artifactId === artifactId) {
      if (tab.code === normalizedCode) {
        this.log.debug('Artifact already rendered with same content - skipping', { artifactId: artifactId.substring(0, 40) });
        this.setActiveTab(tabId);
        return;
      }
      this.log.debug('Updating existing artifact tab', { artifactId: artifactId.substring(0, 40) });
    }

    // Switch to target tab
    if (this.activeTabId !== tabId) {
      this.setActiveTab(tabId);
    }

    // Update tab content (REPLACES content, doesn't accumulate)
    tab.code = normalizedCode;
    tab.language = normalizedLanguage;
    tab.artifactId = artifactId;

    if (filename && filename !== tab.label) {
      tab.label = filename;
      const labelEl = tab.button.querySelector(`.${CONFIG.CLASS_NAMES.TAB_LABEL}`);
      if (labelEl) {
        labelEl.textContent = filename;
      }
    }

    // Update language badge
    const langBadge = tab.content.querySelector('.code-language-badge');
    if (langBadge) {
      langBadge.textContent = this._getLanguageDisplayName(normalizedLanguage);
    }

    // Update editor/display
    if (tab.editor) {
      tab.editor.setValue(normalizedCode, -1); // -1 moves cursor to start
      this.renderer.setEditorLanguage(tab.editor, normalizedLanguage);
    } else {
      // Update fallback display
      const codeEl = tab.content.querySelector('code');
      if (codeEl) {
        codeEl.textContent = normalizedCode;
        codeEl.className = `language-${normalizedLanguage}`;
        
        // Clear previous highlighting to prevent duplicate warning
        delete codeEl.dataset.highlighted;
        if (this.hljs) {
          try {
            this.hljs.highlightElement(codeEl);
          } catch (error) {
            this.log.error('[CodeViewer] Failed to highlight code:', error);
          }
        }
      }
    }

    // Emit event
    this.eventBus.emit(EventTypes.ARTIFACTS.CODE_LOADED, { 
      tabId: this.activeTabId,
      language: normalizedLanguage,
      size: normalizedCode.length,
      timestamp: Date.now()
    });

    // Silent - no logging on every code load
  }

  /**
   * Get code from active tab
   * @returns {Object|null} { code, language, label }
   */
  getCode() {
    if (!this.activeTabId) {
      return null;
    }

    const tab = this.tabsManager.tabs.get(this.activeTabId);
    if (!tab) {
      return null;
    }

    return {
      code: tab.editor ? tab.editor.getValue() : tab.code,
      language: tab.language,
      label: tab.label,
      artifactId: tab.artifactId || null,
    };
  }

  /**
   * Clear all tabs
   */
  clear() {
    // BUG CV-5 FIX: Guard against post-dispose calls
    if (this._isDisposed) return;

    // Close all tabs except first
    const tabIds = Array.from(this.tabsManager.tabs.keys());
    for (const tabId of tabIds.slice(1)) {
      this.closeTab(tabId);
    }

    // Clear first tab content and metadata
    if (tabIds.length > 0) {
      const tab = this.tabsManager.tabs.get(tabIds[0]);
      if (tab) {
        // BUG CV-6 FIX: Clear both ACE editor AND fallback display
        if (tab.editor) {
          tab.editor.setValue('', -1);
        } else {
          const codeEl = tab.content.querySelector('code');
          if (codeEl) {
            codeEl.textContent = '';
            codeEl.className = `language-${CONFIG.CODE.DEFAULT_LANGUAGE}`;
            delete codeEl.dataset.highlighted;
          }
        }

        // BUG CV-7 FIX: Reset tab metadata to prevent stale getCode() results
        tab.code = '';
        tab.language = CONFIG.CODE.DEFAULT_LANGUAGE;
        tab.artifactId = null;
        tab.label = 'Code 1';

        // Update label display
        const labelEl = tab.button.querySelector(`.${CONFIG.CLASS_NAMES.TAB_LABEL}`);
        if (labelEl) labelEl.textContent = 'Code 1';

        // Update language badge
        const langBadge = tab.content.querySelector('.code-language-badge');
        if (langBadge) langBadge.textContent = this._getLanguageDisplayName(CONFIG.CODE.DEFAULT_LANGUAGE);
      }
    }

    this.log.debug('[CodeViewer] Cleared all code');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Create DOM element structure
   * @private
   */
  _createElement() {
    // Create container
    this.container.className += ` ${CONFIG.CLASS_NAMES.CONTAINER}`;

    // Create tabs header
    this.tabsHeader = document.createElement('div');
    this.tabsHeader.className = CONFIG.CLASS_NAMES.TABS_HEADER;

    // Create tabs content
    this.tabsContent = document.createElement('div');
    this.tabsContent.className = CONFIG.CLASS_NAMES.TABS_CONTENT;

    // Append to container
    this.container.appendChild(this.tabsHeader);
    this.container.appendChild(this.tabsContent);

    this.log.debug('[CodeViewer] DOM structure created');
  }

  /**
   * Create tab button
   * @param {string} tabId - Tab ID
   * @param {string} label - Tab label
   * @returns {HTMLElement}
   * @private
   */
  _createTabButton(tabId, label) {
    const button = document.createElement('div');
    button.className = CONFIG.CLASS_NAMES.TAB_BUTTON;
    button.dataset.tabId = tabId;

    // Create label
    const labelSpan = document.createElement('span');
    labelSpan.className = CONFIG.CLASS_NAMES.TAB_LABEL;
    labelSpan.textContent = label;

    // Create close button
    const closeBtn = document.createElement('button');
    closeBtn.className = CONFIG.CLASS_NAMES.TAB_CLOSE;
    closeBtn.textContent = '×';
    closeBtn.title = 'Close tab';

    // Add event listeners
    const handleClick = (e) => {
      if (!e.target.matches(`.${CONFIG.CLASS_NAMES.TAB_CLOSE}`)) {
        this._handleTabClick(tabId);
      }
    };

    const handleClose = (e) => {
      e.stopPropagation();
      this._handleTabClose(tabId);
    };

    button.addEventListener('click', handleClick);
    closeBtn.addEventListener('click', handleClose);

    // BUG CV-4 FIX: Track per-tab (not global) for cleanup on closeTab
    const tabCleanups = this._tabListeners.get(tabId);
    if (tabCleanups) {
      tabCleanups.push(() => {
        button.removeEventListener('click', handleClick);
        closeBtn.removeEventListener('click', handleClose);
      });
    }

    // Assemble button
    button.appendChild(labelSpan);
    button.appendChild(closeBtn);

    // Append to tabs header
    this.tabsHeader.appendChild(button);

    return button;
  }

  /**
   * Create tab content
   * @param {string} tabId - Tab ID
   * @returns {HTMLElement}
   * @private
   */
  _createTabContent(tabId) {
    const content = document.createElement('div');
    content.className = CONFIG.CLASS_NAMES.TAB_CONTENT;
    content.dataset.tabId = tabId;

    // Append to tabs content
    this.tabsContent.appendChild(content);

    return content;
  }

  /**
   * Create editor or display
   * @param {HTMLElement} container - Container element
   * @param {string} code - Initial code
   * @param {string} language - Programming language
   * @returns {Object|null} ACE editor instance or null
   * @private
   */
  _createEditor(container, code, language, tabId = null) {
    // Create editor container
    const editorEl = document.createElement('div');
    editorEl.className = CONFIG.CLASS_NAMES.CODE_EDITOR;
    container.appendChild(editorEl);

    // Create controls (pass tabId for per-tab listener tracking)
    const controls = this._createControls(container, tabId);
    container.insertBefore(controls, editorEl);

    // If ACE is loaded, create editor
    if (this.ace) {
      try {
        const editor = this.ace.edit(editorEl);
        editor.setTheme(`ace/theme/${CONFIG.CODE.DEFAULT_THEME}`);
        this._setEditorLanguage(editor, language);
        editor.setValue(code, -1);
        editor.setOptions({
          fontSize: '13px',
          fontFamily: 'var(--font-family-mono, "Fira Code", "Consolas", monospace)',
          showLineNumbers: CONFIG.CODE.SHOW_LINE_NUMBERS,
          showGutter: CONFIG.CODE.SHOW_GUTTER,
          highlightActiveLine: CONFIG.CODE.HIGHLIGHT_ACTIVE_LINE,
          highlightSelectedWord: true,
          tabSize: CONFIG.CODE.TAB_SIZE,
          wrap: CONFIG.CODE.WRAP,
          enableBasicAutocompletion: CONFIG.CODE.ENABLE_LIVE_AUTOCOMPLETION,
          enableLiveAutocompletion: CONFIG.CODE.ENABLE_LIVE_AUTOCOMPLETION,
          enableSnippets: true,
          showPrintMargin: false,
          useSoftTabs: true,
          behavioursEnabled: true,
          displayIndentGuides: true,
          fadeFoldWidgets: false,
          showFoldWidgets: true,
        });

        return editor;
      } catch (error) {
        this.log.error('[CodeViewer] Failed to create ACE editor:', error);
      }
    }

    // Fallback: simple display with syntax highlighting
    editorEl.className += ` ${CONFIG.CLASS_NAMES.CODE_DISPLAY}`;
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    codeEl.className = `language-${language}`;
    pre.appendChild(codeEl);
    editorEl.appendChild(pre);
    
    if (this.hljs) {
      try {
        this.hljs.highlightElement(codeEl);
      } catch (error) {
        this.log.error('[CodeViewer] Failed to highlight code:', error);
      }
    }

    return null;
  }

  /**
   * Create controls (copy, export buttons)
   * @param {HTMLElement} container - Container element
   * @returns {HTMLElement}
   * @private
   */
  _createControls(container, tabId = null) {
    const controls = document.createElement('div');
    controls.className = `${CONFIG.CLASS_NAMES.CODE_CONTROLS} code-controls`;

    // Language badge (will be updated dynamically)
    const langBadge = document.createElement('div');
    langBadge.className = 'code-language-badge';
    langBadge.textContent = 'Code';
    controls.appendChild(langBadge);

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    controls.appendChild(spacer);

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.dataset.action = 'copy';
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg><span>Copy</span>`;
    copyBtn.title = 'Copy code to clipboard';
    copyBtn.addEventListener('click', this._handleCopyCode);

    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.dataset.action = 'export';
    exportBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg><span>Export</span>`;
    exportBtn.title = 'Export to file';
    exportBtn.addEventListener('click', this._handleExportCode);

    // BUG CV-4 FIX: Track per-tab (not global) for cleanup on closeTab
    const controlCleanup = () => {
      copyBtn.removeEventListener('click', this._handleCopyCode);
      exportBtn.removeEventListener('click', this._handleExportCode);
    };
    const ctrlTabCleanups = tabId ? this._tabListeners.get(tabId) : null;
    if (ctrlTabCleanups) {
      ctrlTabCleanups.push(controlCleanup);
    } else {
      this._eventListeners.push(controlCleanup);
    }

    controls.appendChild(copyBtn);
    controls.appendChild(exportBtn);

    return controls;
  }

  /**
   * Load libraries (ACE, Highlight.js)
   * @private
   */
  async _loadLibraries() {
    if (this.librariesLoaded) {
      return;
    }

    try {
      // Try to load from window (preloaded)
      if (window.ace) {
        this.ace = window.ace;
        this.log.debug('CodeViewer: ACE editor loaded from window');
      } else if (this.aether?.ace) {
        this.ace = this.aether.ace;
        this.log.debug('CodeViewer: ACE editor loaded from aether');
      }

      if (window.hljs) {
        this.hljs = window.hljs;
        this.log.debug('CodeViewer: Highlight.js loaded from window');
      } else if (this.aether?.hljs) {
        this.hljs = this.aether.hljs;
        this.log.debug('CodeViewer: Highlight.js loaded from aether');
      }

      this.librariesLoaded = true;

    } catch (error) {
      this.log.error('[CodeViewer] Failed to load libraries:', error);
    }
  }

  /**
   * Set editor language mode
   * @param {Object} editor - ACE editor instance
   * @param {string} language - Programming language
   * @private
   */
  _setEditorLanguage(editor, language) {
    if (!editor) return;

    try {
      const mode = this._getAceMode(language);
      editor.session.setMode(`ace/mode/${mode}`);
    } catch (error) {
      this.log.error('[CodeViewer] Failed to set editor language:', error);
    }
  }

  /**
   * Get ACE mode for language
   * @param {string} language - Programming language
   * @returns {string}
   * @private
   */
  _getAceMode(language) {
    const langMap = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'rb': 'ruby',
      'sh': 'sh',
      'bash': 'sh',
      'zsh': 'sh',
      'cs': 'csharp',
      'md': 'markdown',
      'yml': 'yaml',
    };

    return langMap[language] || language;
  }

  /**
   * Get display name for language badge
   * @param {string} language - Programming language
   * @returns {string}
   * @private
   */
  _getLanguageDisplayName(language) {
    const normalized = this._normalizeLanguageInput(language);
    const displayMap = {
      'javascript': 'JavaScript',
      'js': 'JavaScript',
      'typescript': 'TypeScript',
      'ts': 'TypeScript',
      'python': 'Python',
      'py': 'Python',
      'java': 'Java',
      'html': 'HTML',
      'css': 'CSS',
      'json': 'JSON',
      'yaml': 'YAML',
      'yml': 'YAML',
      'markdown': 'Markdown',
      'md': 'Markdown',
      'sql': 'SQL',
      'bash': 'Bash',
      'sh': 'Shell',
      'ruby': 'Ruby',
      'rb': 'Ruby',
      'php': 'PHP',
      'go': 'Go',
      'rust': 'Rust',
      'swift': 'Swift',
      'kotlin': 'Kotlin',
      'text': 'Text',
      'txt': 'Text',
    };

    return displayMap[normalized.toLowerCase()] || normalized.toUpperCase();
  }

  _normalizeCodeInput(code) {
    if (code === null || code === undefined) return '';
    let normalized = '';
    if (typeof code === 'string') {
      normalized = code;
    } else if (typeof code === 'number' || typeof code === 'boolean' || typeof code === 'bigint') {
      normalized = String(code);
    } else if (typeof code === 'object') {
      try {
        normalized = JSON.stringify(code, null, 2);
      } catch (error) {
        this.log.warn('[CodeViewer] Failed to stringify code object, using fallback', { error });
        normalized = String(code);
      }
    } else {
      normalized = String(code);
    }

    // Aether fix: Strip markdown code blocks if the model erroneously included them inside the tool call payload
    const trimmed = normalized.trim();
    if (trimmed.startsWith('```')) {
      const lines = trimmed.split('\n');
      if (lines.length > 0 && lines[0].trim().startsWith('```')) {
        lines.shift();
      }
      if (lines.length > 0 && lines[lines.length - 1].trim().startsWith('```')) {
        lines.pop();
      }
      normalized = lines.join('\n').trim();
    }

    return normalized;
  }

  _normalizeLanguageInput(language) {
    if (!language || typeof language !== 'string') {
      return CONFIG.CODE.DEFAULT_LANGUAGE;
    }
    return language;
  }

  /**
   * Handle tab click
   * @param {string} tabId - Tab ID
   * @private
   */
  _handleTabClick(tabId) {
    this.setActiveTab(tabId);
  }

  /**
   * Handle tab close
   * @param {string} tabId - Tab ID
   * @private
   */
  _handleTabClose(tabId) {
    this.closeTab(tabId);
  }

  /**
   * Handle copy code
   * @private
   */
  async _handleCopyCode() {
    const codeData = this.getCode();
    if (!codeData) {
      return;
    }

    try {
      await navigator.clipboard.writeText(codeData.code);
      this.log.debug('[CodeViewer] Code copied to clipboard');
      
      this.eventBus.emit(EventTypes.UI.NOTIFICATION, { 
        message: 'Code copied to clipboard',
        type: 'success'
      });

    } catch (error) {
      this.log.error('[CodeViewer] Failed to copy code:', error);
      
      this.eventBus.emit(EventTypes.UI.ERROR, { 
        message: 'Failed to copy code',
        error
      });
    }
  }

  /**
   * Handle export code
   * @private
   */
  async _handleExportCode() {
    const codeData = this.getCode();
    if (!codeData) {
      return;
    }

    try {
      const extension = this._getFileExtension(codeData.language);
      const filename = codeData.label || `code.${extension}`;
      
      // Delegate to controller
      await this.controller.exportFile(codeData.code, filename, extension);
      
      this.log.debug('[CodeViewer] Code exported:', filename);

    } catch (error) {
      this.log.error('[CodeViewer] Failed to export code:', error);
      
      this.eventBus.emit(EventTypes.UI.ERROR, { 
        message: 'Failed to export code',
        error
      });
    }
  }

  /**
   * Get file extension for language
   * @param {string} language - Programming language
   * @returns {string}
   * @private
   */
  _getFileExtension(language) {
    const extMap = {
      'javascript': 'js',
      'typescript': 'ts',
      'python': 'py',
      'ruby': 'rb',
      'shell': 'sh',
      'bash': 'sh',
      'csharp': 'cs',
      'markdown': 'md',
      'yaml': 'yml',
    };

    return extMap[language] || language;
  }

  /**
   * Escape HTML
   * @param {string} html - HTML string
   * @returns {string}
   * @private
   */
  _escapeHtml(html) {
    const div = document.createElement('div');
    div.textContent = html;
    return div.innerHTML;
  }

  /**
   * Inject styles
   * @private
   */
  _injectStyles() {
    const styleId = 'code-viewer-styles';
    const existingEl = document.getElementById(styleId);

    // BUG CV-8 FIX: Resync ref count if element was removed externally
    // (e.g., parent container teardown, test cleanup). Prevents permanent desync.
    if (!existingEl && _styleRefCount > 0) {
      _styleRefCount = 0;
    }

    _styleRefCount++;
    if (existingEl) {
      return;
    }

    const styles = `
      /* Code Viewer Container */
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      /* Code Tabs Header — hidden by default (single-tab mode) */
      .${CONFIG.CLASS_NAMES.TABS_HEADER} {
        display: flex;
        gap: 4px;
        padding: 6px 8px;
        background: transparent;
        border-bottom: none;
        overflow-x: auto;
        flex-shrink: 0;
      }

      .${CONFIG.CLASS_NAMES.TAB_BUTTON} {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-tertiary);
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        white-space: nowrap;
        position: relative;
        overflow: hidden;
      }

      .${CONFIG.CLASS_NAMES.TAB_BUTTON}::before {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(255, 255, 255, 0.04);
        opacity: 0;
        transition: opacity 0.2s;
      }

      .${CONFIG.CLASS_NAMES.TAB_BUTTON}:hover {
        color: var(--color-text-primary);
        background: rgba(255, 255, 255, 0.06);
        border-color: transparent;
      }

      .${CONFIG.CLASS_NAMES.TAB_BUTTON}:hover::before {
        opacity: 1;
      }

      .${CONFIG.CLASS_NAMES.TAB_BUTTON}.${CONFIG.CLASS_NAMES.ACTIVE_TAB} {
        color: var(--color-text-primary);
        background: rgba(255, 255, 255, 0.08);
        border-color: transparent;
        box-shadow: none;
        font-weight: var(--font-weight-semibold);
      }

      .${CONFIG.CLASS_NAMES.TAB_CLOSE} {
        width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--font-size-sm);
        color: var(--color-text-disabled);
        background: transparent;
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
        z-index: 1;
      }

      .${CONFIG.CLASS_NAMES.TAB_CLOSE}:hover {
        color: var(--color-error);
        background: var(--color-error-bg);
      }

      .${CONFIG.CLASS_NAMES.TABS_CONTENT} {
        flex: 1;
        position: relative;
        overflow: hidden;
      }

      .${CONFIG.CLASS_NAMES.TAB_CONTENT} {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: none;
        flex-direction: column;
        overflow: hidden;
      }

      .${CONFIG.CLASS_NAMES.TAB_CONTENT}.${CONFIG.CLASS_NAMES.ACTIVE_TAB} {
        display: flex;
      }

      .${CONFIG.CLASS_NAMES.CODE_EDITOR} {
        flex: 1;
        overflow: auto;
        background: transparent;
        position: relative;
        min-height: 0;
      }

      .${CONFIG.CLASS_NAMES.CODE_DISPLAY} pre {
        margin: 0;
        padding: 16px;
        font-family: var(--font-family-mono);
        font-size: var(--font-size-sm);
        line-height: 1.6;
        color: var(--color-text-primary);
        background: transparent;
        overflow-x: hidden; /* UX FIX: Prevent horizontal scroll by forcing wrap */
        white-space: pre-wrap; /* UX FIX: Wrap code by default */
        word-wrap: break-word;
        word-break: break-word;
        width: 100%;
        height: 100%;
      }
      
      .${CONFIG.CLASS_NAMES.CODE_DISPLAY} pre code {
        display: block;
        width: 100%;
        height: 100%;
      }
    `;

    const styleElement = document.createElement('style');
    styleElement.id = styleId;
    styleElement.textContent = styles;
    document.head.appendChild(styleElement);

    this.log.debug('[CodeViewer] Styles injected');
  }
}

// Export
module.exports = CodeViewer;

if (typeof window !== 'undefined') {
  window.CodeViewer = CodeViewer;
}
