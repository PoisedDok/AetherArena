'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController (loadCode method), IPC 'artifacts:load-code' events, window.hljs/window.ace --- {artifact_types.code_artifact, json}
 * Processing: Create tab-based UI, lazy load ACE editor & Highlight.js, render syntax highlighted code, manage editor state, handle copy/execute/export actions --- {8 jobs: JOB_CREATE_DOM_ELEMENT, JOB_RENDER_MARKDOWN, JOB_UPDATE_STATE, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_TRACK_ENTITY}
 * Outgoing: DOM (code editor with syntax highlighting), ArtifactsController.executeCode(), ArtifactsController.exportFile(), EventBus --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/code/CodeViewer
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { freeze } = Object;

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
    if (!options.controller) {
      throw new Error('[CodeViewer] Controller required');
    }

    if (!options.eventBus) {
      throw new Error('[CodeViewer] EventBus required');
    }

    this.controller = options.controller;
    this.eventBus = options.eventBus;

    // DOM elements
    this.container = null;
    this.tabsHeader = null;
    this.tabsContent = null;

    // Tabs state
    this.tabs = new Map(); // tabId -> { id, button, content, editor, language, code }
    this.activeTabId = null;
    this.tabCounter = 0;

    // Libraries (lazy loaded)
    this.ace = null;
    this.hljs = null;
    this.librariesLoaded = false;

    // Event handlers (for cleanup)
    this._eventListeners = [];

    // Bind methods
    this._handleTabClick = this._handleTabClick.bind(this);
    this._handleTabClose = this._handleTabClose.bind(this);
    this._handleCopyCode = this._handleCopyCode.bind(this);
    this._handleExecuteCode = this._handleExecuteCode.bind(this);
    this._handleExportCode = this._handleExportCode.bind(this);
  }

  /**
   * Initialize code viewer
   * @param {HTMLElement} container - Container pane element
   */
  async init(container) {
    console.log('💻 CodeViewer: Initializing...');

    try {
      if (!container) {
        throw new Error('[CodeViewer] Container required');
      }

      this.container = container;

      // Create DOM structure
      this._createElement();

      // Inject styles
      this._injectStyles();

      // Load libraries (async)
      this._loadLibraries();

      // Create default tab
      this.createTab('Code 1', '', CONFIG.CODE.DEFAULT_LANGUAGE);

      // Emit ready event
      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'CodeViewer',
        timestamp: Date.now()
      });

      console.log('✅ CodeViewer: Initialized');

    } catch (error) {
      console.error('❌ CodeViewer: Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Dispose code viewer and cleanup
   */
  dispose() {
    console.log('🛑 CodeViewer: Disposing...');

    // Dispose ACE editors
    for (const [, tab] of this.tabs) {
      if (tab.editor) {
        try {
          tab.editor.destroy();
        } catch (error) {
          console.error('[CodeViewer] Failed to destroy editor:', error);
        }
      }
    }

    // Clear tabs
    this.tabs.clear();

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[CodeViewer] Failed to cleanup event listener:', error);
      }
    }
    this._eventListeners = [];

    // Clear references
    this.container = null;
    this.tabsHeader = null;
    this.tabsContent = null;
    this.ace = null;
    this.hljs = null;

    console.log('✅ CodeViewer: Disposed');
  }

  /**
   * Create a new tab
   * @param {string} label - Tab label
   * @param {string} code - Initial code content
   * @param {string} language - Programming language
   * @returns {string} Tab ID
   */
  createTab(label, code = '', language = CONFIG.CODE.DEFAULT_LANGUAGE) {
    // Check max tabs limit
    if (this.tabs.size >= CONFIG.CODE.MAX_TABS) {
      console.warn('[CodeViewer] Maximum tabs reached');
      this.eventBus.emit(EventTypes.UI.ERROR, { 
        message: 'Maximum code tabs reached',
        limit: CONFIG.CODE.MAX_TABS
      });
      return null;
    }

    const tabId = `code-tab-${++this.tabCounter}-${Date.now()}`;

    // Create tab button
    const button = this._createTabButton(tabId, label);

    // Create tab content
    const content = this._createTabContent(tabId);

    // Create editor or display
    const editor = this._createEditor(content, code, language);

    // Store tab
    this.tabs.set(tabId, {
      id: tabId,
      label,
      button,
      content,
      editor,
      language,
      code,
    });

    // Set as active
    this.setActiveTab(tabId);

    // Emit event
    this.eventBus.emit(EventTypes.ARTIFACTS.CODE_TAB_CREATED, { 
      tabId,
      label,
      language,
      timestamp: Date.now()
    });

    console.log(`[CodeViewer] Created tab: ${tabId}`);

    return tabId;
  }

  /**
   * Close a tab
   * @param {string} tabId - Tab ID to close
   */
  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      console.warn(`[CodeViewer] Tab not found: ${tabId}`);
      return;
    }

    // Destroy editor
    if (tab.editor) {
      try {
        tab.editor.destroy();
      } catch (error) {
        console.error('[CodeViewer] Failed to destroy editor:', error);
      }
    }

    // Remove DOM elements
    if (tab.button && tab.button.parentNode) {
      tab.button.parentNode.removeChild(tab.button);
    }
    if (tab.content && tab.content.parentNode) {
      tab.content.parentNode.removeChild(tab.content);
    }

    // Remove from tabs
    this.tabs.delete(tabId);

    // If closing active tab, activate another tab
    if (this.activeTabId === tabId) {
      if (this.tabs.size > 0) {
        const firstTabId = this.tabs.keys().next().value;
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

    console.log(`[CodeViewer] Closed tab: ${tabId}`);
  }

  /**
   * Set active tab
   * @param {string} tabId - Tab ID to activate
   */
  setActiveTab(tabId) {
    if (!this.tabs.has(tabId)) {
      console.warn(`[CodeViewer] Tab not found: ${tabId}`);
      return;
    }

    // Deactivate all tabs
    for (const [id, tab] of this.tabs) {
      tab.button.classList.remove(CONFIG.CLASS_NAMES.ACTIVE_TAB);
      tab.content.classList.remove(CONFIG.CLASS_NAMES.ACTIVE_TAB);
    }

    // Activate target tab
    const tab = this.tabs.get(tabId);
    tab.button.classList.add(CONFIG.CLASS_NAMES.ACTIVE_TAB);
    tab.content.classList.add(CONFIG.CLASS_NAMES.ACTIVE_TAB);

    // Update state
    this.activeTabId = tabId;

    // Refresh editor if present
    if (tab.editor && tab.editor.resize) {
      setTimeout(() => tab.editor.resize(), 100);
    }

    // Emit event
    this.eventBus.emit(EventTypes.ARTIFACTS.CODE_TAB_CHANGED, { 
      tabId,
      language: tab.language,
      timestamp: Date.now()
    });

    console.log(`[CodeViewer] Active tab: ${tabId}`);
  }

  /**
   * Load code into active tab
   * @param {string} code - Code content
   * @param {string} language - Programming language
   * @param {string} filename - Optional filename
   */
  loadCode(code, language = CONFIG.CODE.DEFAULT_LANGUAGE, filename = null) {
    if (!this.activeTabId) {
      // Create new tab if none exists
      const label = filename || `Code ${this.tabCounter + 1}`;
      this.createTab(label, code, language);
      return;
    }

    const tab = this.tabs.get(this.activeTabId);
    if (!tab) {
      console.warn('[CodeViewer] Active tab not found');
      return;
    }

    // Update tab
    tab.code = code;
    tab.language = language;

    if (filename) {
      tab.label = filename;
      const labelEl = tab.button.querySelector(`.${CONFIG.CLASS_NAMES.TAB_LABEL}`);
      if (labelEl) {
        labelEl.textContent = filename;
      }
    }

    // Update editor/display
    if (tab.editor) {
      tab.editor.setValue(code, -1); // -1 moves cursor to start
      this._setEditorLanguage(tab.editor, language);
    } else {
      // Update fallback display
      const codeEl = tab.content.querySelector('code');
      if (codeEl) {
        codeEl.textContent = code;
        codeEl.className = `language-${language}`;
        if (this.hljs) {
          try {
            this.hljs.highlightElement(codeEl);
          } catch (error) {
            console.error('[CodeViewer] Failed to highlight code:', error);
          }
        }
      }
    }

    // Emit event
    this.eventBus.emit(EventTypes.ARTIFACTS.CODE_LOADED, { 
      tabId: this.activeTabId,
      language,
      size: code.length,
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

    const tab = this.tabs.get(this.activeTabId);
    if (!tab) {
      return null;
    }

    return {
      code: tab.editor ? tab.editor.getValue() : tab.code,
      language: tab.language,
      label: tab.label,
    };
  }

  /**
   * Clear all tabs
   */
  clear() {
    // Close all tabs except first
    const tabIds = Array.from(this.tabs.keys());
    for (const tabId of tabIds.slice(1)) {
      this.closeTab(tabId);
    }

    // Clear first tab
    if (tabIds.length > 0) {
      const tab = this.tabs.get(tabIds[0]);
      if (tab && tab.editor) {
        tab.editor.setValue('', -1);
      }
    }

    console.log('[CodeViewer] Cleared all code');
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

    console.log('[CodeViewer] DOM structure created');
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

    this._eventListeners.push(() => {
      button.removeEventListener('click', handleClick);
      closeBtn.removeEventListener('click', handleClose);
    });

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
  _createEditor(container, code, language) {
    // Create editor container
    const editorEl = document.createElement('div');
    editorEl.className = CONFIG.CLASS_NAMES.CODE_EDITOR;
    container.appendChild(editorEl);

    // Create controls
    const controls = this._createControls(container);
    container.insertBefore(controls, editorEl);

    // If ACE is loaded, create editor
    if (this.ace) {
      try {
        const editor = this.ace.edit(editorEl);
        editor.setTheme(`ace/theme/${CONFIG.CODE.DEFAULT_THEME}`);
        this._setEditorLanguage(editor, language);
        editor.setValue(code, -1);
        editor.setOptions({
          fontSize: '14px',
          showLineNumbers: CONFIG.CODE.SHOW_LINE_NUMBERS,
          showGutter: CONFIG.CODE.SHOW_GUTTER,
          highlightActiveLine: CONFIG.CODE.HIGHLIGHT_ACTIVE_LINE,
          tabSize: CONFIG.CODE.TAB_SIZE,
          wrap: CONFIG.CODE.WRAP,
          enableBasicAutocompletion: CONFIG.CODE.ENABLE_LIVE_AUTOCOMPLETION,
          enableLiveAutocompletion: CONFIG.CODE.ENABLE_LIVE_AUTOCOMPLETION,
        });

        return editor;
      } catch (error) {
        console.error('[CodeViewer] Failed to create ACE editor:', error);
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
        console.error('[CodeViewer] Failed to highlight code:', error);
      }
    }

    return null;
  }

  /**
   * Create controls (copy, execute, export buttons)
   * @param {HTMLElement} container - Container element
   * @returns {HTMLElement}
   * @private
   */
  _createControls(container) {
    const controls = document.createElement('div');
    controls.className = CONFIG.CLASS_NAMES.CODE_CONTROLS;

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.addEventListener('click', this._handleCopyCode);

    // Execute button
    const executeBtn = document.createElement('button');
    executeBtn.textContent = 'Execute';
    executeBtn.title = 'Execute code';
    executeBtn.addEventListener('click', this._handleExecuteCode);

    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.title = 'Export to file';
    exportBtn.addEventListener('click', this._handleExportCode);

    this._eventListeners.push(() => {
      copyBtn.removeEventListener('click', this._handleCopyCode);
      executeBtn.removeEventListener('click', this._handleExecuteCode);
      exportBtn.removeEventListener('click', this._handleExportCode);
    });

    controls.appendChild(copyBtn);
    controls.appendChild(executeBtn);
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
        console.log('✅ [CodeViewer] ACE editor loaded from window');
      } else if (window.aether && window.aether.ace) {
        this.ace = window.aether.ace;
        console.log('✅ [CodeViewer] ACE editor loaded from window.aether');
      }

      if (window.hljs) {
        this.hljs = window.hljs;
        console.log('✅ [CodeViewer] Highlight.js loaded from window');
      } else if (window.aether && window.aether.hljs) {
        this.hljs = window.aether.hljs;
        console.log('✅ [CodeViewer] Highlight.js loaded from window.aether');
      }

      this.librariesLoaded = true;

    } catch (error) {
      console.error('[CodeViewer] Failed to load libraries:', error);
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
      console.error('[CodeViewer] Failed to set editor language:', error);
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
      console.log('[CodeViewer] Code copied to clipboard');
      
      this.eventBus.emit(EventTypes.UI.NOTIFICATION, { 
        message: 'Code copied to clipboard',
        type: 'success'
      });

    } catch (error) {
      console.error('[CodeViewer] Failed to copy code:', error);
      
      this.eventBus.emit(EventTypes.UI.ERROR, { 
        message: 'Failed to copy code',
        error
      });
    }
  }

  /**
   * Handle execute code
   * @private
   */
  async _handleExecuteCode() {
    const codeData = this.getCode();
    if (!codeData) {
      return;
    }

    try {
      // Delegate to controller
      const result = await this.controller.executeCode(codeData.code, codeData.language);
      
      console.log('[CodeViewer] Code executed:', result);

    } catch (error) {
      console.error('[CodeViewer] Failed to execute code:', error);
      
      this.eventBus.emit(EventTypes.UI.ERROR, { 
        message: 'Code execution failed',
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
      
      console.log('[CodeViewer] Code exported:', filename);

    } catch (error) {
      console.error('[CodeViewer] Failed to export code:', error);
      
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

    if (document.getElementById(styleId)) {
      return;
    }

    const styles = `
      /* Code Viewer */
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
      }

      .${CONFIG.CLASS_NAMES.TABS_HEADER} {
        display: flex;
        gap: 4px;
        padding: 8px;
        background: rgba(25, 25, 30, 0.95);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        overflow-x: auto;
        flex-shrink: 0;
      }

      .${CONFIG.CLASS_NAMES.TAB_BUTTON} {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        font-size: 13px;
        color: rgba(255, 255, 255, 0.7);
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        cursor: pointer;
        transition: all 200ms ease;
        white-space: nowrap;
      }

      .${CONFIG.CLASS_NAMES.TAB_BUTTON}:hover {
        color: rgba(255, 255, 255, 0.95);
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.2);
      }

      .${CONFIG.CLASS_NAMES.TAB_BUTTON}.${CONFIG.CLASS_NAMES.ACTIVE_TAB} {
        color: rgba(255, 255, 255, 0.98);
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.25);
      }

      .${CONFIG.CLASS_NAMES.TAB_CLOSE} {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        color: rgba(255, 255, 255, 0.5);
        background: transparent;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        transition: all 200ms ease;
      }

      .${CONFIG.CLASS_NAMES.TAB_CLOSE}:hover {
        color: rgba(255, 255, 255, 0.95);
        background: rgba(255, 255, 255, 0.15);
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

      .${CONFIG.CLASS_NAMES.CODE_CONTROLS} {
        display: flex;
        gap: 8px;
        padding: 8px;
        background: rgba(25, 25, 30, 0.95);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        flex-shrink: 0;
      }

      .${CONFIG.CLASS_NAMES.CODE_CONTROLS} button {
        padding: 6px 12px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.85);
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        cursor: pointer;
        transition: all 200ms ease;
      }

      .${CONFIG.CLASS_NAMES.CODE_CONTROLS} button:hover {
        color: rgba(255, 255, 255, 0.98);
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.3);
      }

      .${CONFIG.CLASS_NAMES.CODE_EDITOR} {
        flex: 1;
        overflow: auto;
        background: var(--color-bg-primary);
        position: relative;
        min-height: 0;
      }

      .${CONFIG.CLASS_NAMES.CODE_DISPLAY} pre {
        margin: 0;
        padding: 16px;
        font-family: var(--font-family-mono);
        font-size: 14px;
        line-height: 1.6;
        color: rgba(255, 255, 255, 0.95);
        background: transparent;
        overflow-x: auto;
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

    console.log('[CodeViewer] Styles injected');
  }
}

// Export
module.exports = CodeViewer;

if (typeof window !== 'undefined') {
  window.CodeViewer = CodeViewer;
  console.log('📦 CodeViewer loaded');
}

