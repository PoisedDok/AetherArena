'use strict';

/**
 * @.architecture
 * Incoming: renderer/artifacts/controllers/ArtifactsController.js --- {ipc.chat_stream_event, json}
 * Processing: Detect format, route to specialized renderer, manage toolbar and a11y --- {4 jobs: JOB_CREATE_WRAPPER, JOB_DELEGATE_TO_MODULE, JOB_ROUTE_BY_TYPE, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: renderer/artifacts/modules/output/renderers/* --- {dom.artifact_panel, HTMLElement}
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const { createRendererLogger } = require('../../../shared/utils/logger');
const ContentExporter = require('../../../shared/utils/ContentExporter');
const HtmlRenderer = require('./renderers/HtmlRenderer');
const MarkdownRenderer = require('./renderers/MarkdownRenderer');
const JsonRenderer = require('./renderers/JsonRenderer');
const MediaRenderer = require('./renderers/MediaRenderer');
const SearchResultsRenderer = require('./renderers/SearchResultsRenderer');
const { freeze } = Object;

// Output viewer configuration
const CONFIG = freeze({
  FORMATS: freeze({
    HTML: 'html',
    MARKDOWN: 'markdown',
    JSON: 'json',
    TEXT: 'text',
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    MEDIA: 'media',
  }),
  CLASS_NAMES: freeze({
    CONTAINER: 'output-viewer-container',
    CONTROLS: 'output-controls',
    TOOLBAR: 'output-toolbar',
    BTN: 'ov-btn',
    CONTENT: 'output-content',
    FORMAT_SELECT: 'format-select',
    WRAP_ACTIVE: 'wrap-lines',
  }),
  DEFAULT_FORMAT: 'text',
  // BUG OV-6 FIX: Unified threshold for consistent scroll detection UX
  SCROLL_THRESHOLD: 20,
});

class OutputViewer {
  /**
   * Create output viewer
   * @param {Object} options - Configuration options
   * @param {Object} options.controller - Artifacts controller instance
   * @param {Object} options.eventBus - Event bus for communication
   */
  constructor(options = {}) {
    this.log = createRendererLogger('OutputViewer');
    if (!options.controller) {
      throw new Error('[OutputViewer] Controller required');
    }

    if (!options.eventBus) {
      throw new Error('[OutputViewer] EventBus required');
    }

    this.controller = options.controller;
    this.eventBus = options.eventBus;

    // DOM elements
    this.container = null;
    this.controlsContainer = null;
    this.toolbarContainer = null;
    this.contentContainer = null;
    this.formatSelect = null;
    this.scrollToBottomBtn = null; // BUG OV-5 FIX: Floating auto-scroll button

    // Renderers
    this.renderers = new Map();
    this._initializeRenderers();

    // Tab State
    this.tabs = new Map(); // artifactId -> { data, format, btn }
    this.activeTabId = null;
    this.tabCounter = 0;

    // State
    this.currentFormat = CONFIG.DEFAULT_FORMAT;
    this.currentData = null;
    this.currentArtifactId = null;
    this._wrapEnabled = true; // UX FIX: Default to wrap enabled
    this._shouldAutoScroll = true; // BUG OV-5 FIX: Track auto-scroll state
    
    // Phase 1: Stream Buffering
    this._streamBuffer = [];
    this._rafId = null;
    this._isStreaming = false;

    // Lifecycle flags
    this._isDisposed = false;
    this._initialized = false;

    // Event handlers (for cleanup)
    this._eventListeners = [];

    // Bind methods
    this._handleFormatChange = this._handleFormatChange.bind(this);
    this._handleClear = this._handleClear.bind(this);
    this._handleCopyAll = this._handleCopyAll.bind(this);
    this._handleDownload = this._handleDownload.bind(this);
    this._handleExportPdf = this._handleExportPdf.bind(this);
    this._handleToggleWrap = this._handleToggleWrap.bind(this);
    this._handleScroll = this._handleScroll.bind(this);
    this._scrollToBottom = this._scrollToBottom.bind(this);
  }

  /**
   * Initialize output viewer
   * @param {HTMLElement} container - Container pane element
   */
  async init(container) {
    // BUG OV-1 FIX: Prevent zombie resurrection and double-init
    if (this._isDisposed) return;
    if (this._initialized) return;
    this.log.debug('OutputViewer: Initializing...');

    try {
      if (!container) {
        throw new Error('[OutputViewer] Container required');
      }

      this.container = container;

      // Create DOM structure
      this._createElement();

      // Inject styles
      this._injectStyles();

      // Accessibility
      this._setupAccessibility();

      this._initialized = true; // BUG OV-1 FIX: Mark initialized

      // Emit ready event
      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'OutputViewer',
        timestamp: Date.now()
      });

      this.log.debug('OutputViewer: Initialized');

    } catch (error) {
      this.log.error('OutputViewer: Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Dispose output viewer and cleanup
   */
  dispose() {
    // BUG OV-2 FIX: Idempotent dispose with flag set FIRST
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.log.debug('OutputViewer: Disposing...');

    // Dispose renderers
    for (const [, renderer] of this.renderers) {
      if (renderer && typeof renderer.dispose === 'function') {
        try {
          renderer.dispose();
        } catch (error) {
          this.log.error('[OutputViewer] Failed to dispose renderer:', error);
        }
      }
    }
    this.renderers.clear();

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        this.log.error('[OutputViewer] Failed to cleanup event listener:', error);
      }
    }
    this._eventListeners = [];

    // BUG OV-3 FIX: Release data references for GC
    this.currentData = null;
    this.currentArtifactId = null;

    // Clear DOM references
    this.container = null;
    this.controlsContainer = null;
    this.toolbarContainer = null;
    this.contentContainer = null;
    this.tabsHeader = null;
    this.formatSelect = null;
    this.exportPdfBtn = null;
    this.scrollToBottomBtn = null; // BUG OV-6 FIX: Clear floating button reference

    // Phase 1: Stream Buffering
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._streamBuffer = [];
    this._isStreaming = false;

    // Tabs Cleanup
    this.tabs.clear();
    this.activeTabId = null;
    this.tabCounter = 0;

    // BUG OV-6 FIX: Reset state flags
    this._shouldAutoScroll = true;
    this._initialized = false;
    this.log.debug('OutputViewer: Disposed');
  }

  /**
   * Queue output content into stream buffer
   * @param {*} data - Output data to display
   * @param {string} format - Optional format override
   * @param {string} artifactId - Optional artifact ID
   */
  async loadOutput(data, format = null, artifactId = null) {
    if (this._isDisposed) return;
    
    // Push the newest state into the buffer
    this._streamBuffer.push({ data, format, artifactId });
    
    if (!this._isStreaming) {
      this._isStreaming = true;
      const flush = () => this._flushStreamBuffer();
      // Allow fast-path for tests
      if (typeof process !== 'undefined' && process.env.JEST_WORKER_ID) {
        await flush();
      } else {
        this._rafId = requestAnimationFrame(flush);
      }
    }
  }

  /**
   * Phase 1: Flush stream buffer via RAF
   * @private
   */
  async _flushStreamBuffer() {
    if (this._isDisposed || this._streamBuffer.length === 0) {
      this._isStreaming = false;
      return;
    }

    // Take the LATEST frame state from the buffer (discard intermediate thrashing)
    const latest = this._streamBuffer[this._streamBuffer.length - 1];
    this._streamBuffer = []; // Clear buffer
    this._isStreaming = false;

    await this._renderOutput(latest.data, latest.format, latest.artifactId);
  }

  _getOrCreateTab(artifactId) {
    if (!artifactId) {
      artifactId = `output-tab-no-id-${Date.now()}`;
    }
    if (this.tabs.has(artifactId)) {
      return this.tabs.get(artifactId);
    }
    
    // Create new tab
    const tabNum = ++this.tabCounter;
    const btn = document.createElement('button');
    btn.className = 'output-tab-btn';
    btn.innerHTML = `<i class="fas fa-terminal" style="font-size: 10px; opacity: 0.7;"></i> Out ${tabNum}`;
    btn.title = artifactId;
    btn.onclick = () => this._setActiveTab(artifactId);
    
    this.tabsHeader.appendChild(btn);
    
    const tab = {
      id: artifactId,
      btn,
      data: null,
      format: null
    };
    
    this.tabs.set(artifactId, tab);
    
    // Show tabs header if more than 1 tab
    if (this.tabs.size > 1) {
      this.tabsHeader.style.display = 'flex';
    } else {
      this.tabsHeader.style.display = 'none'; // Keep hidden if only 1
    }
    
    return tab;
  }

  async _setActiveTab(artifactId, forceRender = false) {
    if (this.activeTabId === artifactId && !forceRender) return;
    
    // Deactivate old
    if (this.activeTabId && this.tabs.has(this.activeTabId)) {
      this.tabs.get(this.activeTabId).btn.classList.remove('active');
    }
    
    // Activate new
    this.activeTabId = artifactId;
    const tab = this.tabs.get(artifactId);
    tab.btn.classList.add('active');
    tab.btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    
    // Restore state
    this.currentData = tab.data;
    this.currentArtifactId = tab.id;
    this.currentFormat = tab.format || CONFIG.DEFAULT_FORMAT;
    
    // Ensure format select is updated
    if (this.formatSelect && this.formatSelect.value !== this.currentFormat) {
      // Temporarily remove listener to prevent infinite loop if we manually trigger change
      this.formatSelect.value = this.currentFormat;
    }
    
    // Gate PDF export: hide for media formats
    if (this.exportPdfBtn) {
      const isMedia = [CONFIG.FORMATS.IMAGE, CONFIG.FORMATS.VIDEO, CONFIG.FORMATS.AUDIO, CONFIG.FORMATS.MEDIA].includes(this.currentFormat);
      this.exportPdfBtn.style.display = isMedia ? 'none' : '';
    }
    
    // Force re-render with stored data
    if (this.contentContainer) {
      this.contentContainer.dataset.renderedFormat = ''; // force clear content
      await this._render(tab.data, this.currentFormat);
      this._performAutoScroll();
    }
  }

  /**
   * Core output rendering logic (previously loadOutput)
   * @param {*} data - Output data to display
   * @param {string} format - Optional format override
   */
  async _renderOutput(data, format = null, artifactId = null) {
    // BUG OV-4 FIX: Guard against post-dispose calls
    if (this._isDisposed) return;
    try {
      this.log.debug('[OutputViewer] loadOutput called', {
        dataType: typeof data,
        dataLength: typeof data === 'string' ? data.length : JSON.stringify(data).length,
        format: format || 'auto-detect',
        artifactId: artifactId ? artifactId.substring(0, 40) : 'none'
      });
      
      // CRITICAL: Strip backend logs that leak into output
      // Pattern: "2026-01-08 14:59:20,320 - interpreter.core.computer.tools_loader - INFO - ..."
      if (typeof data === 'string') {
        const originalLength = data.length;
        data = data.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2},\d{3}\s+-\s+[\w.]+\s+-\s+\w+\s+-\s+.+$/gm, '');
        data = data.trim();
        if (data.length < originalLength) {
          this.log.debug('[OutputViewer] Stripped backend logs from output', {
            originalLength,
            newLength: data.length
          });
        }
      }

      // FAIL FAST: Prevent duplicate artifact rendering
      // If artifact_id provided and matches current, check if content changed
      if (artifactId && this.currentArtifactId === artifactId) {
        if (this.currentData === data) {
          this.log.debug('[OutputViewer] Artifact already rendered with same content - skipping', {
            artifactId: artifactId.substring(0, 40)
          });
          return;
        } else {
          this.log.debug('[OutputViewer] Updating existing artifact with new content', {
            artifactId: artifactId.substring(0, 40)
          });
        }
      }

      // BUG OV-6 FIX: Check scroll position BEFORE clearing content
      // This preserves the user's scroll position decision for auto-scroll logic
      this._checkAutoScroll();

      // CRITICAL FIX: Re-detect format if provided format is "text" or "markdown" but content
      // is actually structured data. Backend may label HTML, JSON, or search results
      // as format=text or format=markdown. Without this override, tool outputs
      // (search results, JSON data) render as raw text instead of formatted cards.
      //
      // Override logic:
      //   text     → override to anything more specific (markdown, json, html, search_results)
      //   markdown → override only to json, html, search_results (not back to text)
      //   json     → override only to search_results
      // Object data labeled as text/markdown/json should still pass through detection so
      // search_results objects are not downgraded to generic JSON.
      if ((format === 'text' || format === 'markdown' || format === 'json') && typeof data === 'object' && data !== null) {
        const detectedFormat = this._detectFormat(data);
        const shouldOverride = format === 'text'
          ? detectedFormat !== CONFIG.FORMATS.TEXT
          : format === 'markdown'
            ? detectedFormat !== CONFIG.FORMATS.TEXT && detectedFormat !== CONFIG.FORMATS.MARKDOWN
            : detectedFormat === 'search_results'; // for json, only override if it's search_results
            
        if (shouldOverride) {
          this.log.debug('[OutputViewer] Overriding object format: ' + format + ' -> ' + detectedFormat, {
            reason: 'Object content is structured but labeled as ' + format,
            artifactId: artifactId ? artifactId.substring(0, 40) : 'none'
          });
          format = detectedFormat;
        }
      }

      if ((format === 'text' || format === 'markdown' || format === 'json') && typeof data === 'string' && data.trim().length > 0) {
        const detectedFormat = this._detectFormat(data);
        const shouldOverride = format === 'text'
          ? detectedFormat !== CONFIG.FORMATS.TEXT
          : format === 'markdown'
            ? detectedFormat !== CONFIG.FORMATS.TEXT && detectedFormat !== CONFIG.FORMATS.MARKDOWN
            : detectedFormat === 'search_results'; // for json, only override if it's search_results
            
        if (shouldOverride) {
          this.log.debug('[OutputViewer] Overriding format: ' + format + ' -> ' + detectedFormat, {
            reason: 'Content is structured but labeled as ' + format,
            artifactId: artifactId ? artifactId.substring(0, 40) : 'none'
          });
          format = detectedFormat;
        }
      }
      
      // Detect format if not provided
      if (!format) {
        format = this._detectFormat(data);
      }

      // UX FIX: Multi-tab support. Update tab with new data & format.
      const tab = this._getOrCreateTab(artifactId);
      tab.data = data;
      tab.format = format;

      // If this is the active tab (or no active tab yet), render it directly
      if (!this.activeTabId || this.activeTabId === tab.id) {
        // Store data locally as current
        this.currentData = data;
        this.currentArtifactId = tab.id;
        this.currentFormat = format;

        // Activate the tab button
        tab.btn.classList.add('active');
        this.activeTabId = tab.id;

        // Update format select
        if (this.formatSelect && this.formatSelect.value !== format) {
          this.formatSelect.value = format;
        }

        // Gate PDF export: hide for media formats
        if (this.exportPdfBtn) {
          const isMedia = [CONFIG.FORMATS.IMAGE, CONFIG.FORMATS.VIDEO, CONFIG.FORMATS.AUDIO, CONFIG.FORMATS.MEDIA].includes(format);
          this.exportPdfBtn.style.display = isMedia ? 'none' : '';
        }

        // Render with appropriate renderer
        await this._render(data, format);

        // BUG OV-5 FIX: After rendering, perform auto-scroll or update button visibility
        this._performAutoScroll();
      } else {
        this.log.debug('[OutputViewer] Updated background tab output without re-rendering', { artifactId: tab.id });
      }

      // Emit event
      this.eventBus.emit(EventTypes.ARTIFACTS.OUTPUT_LOADED, { 
        format,
        size: typeof data === 'string' ? data.length : JSON.stringify(data).length,
        timestamp: Date.now()
      });

      this.log.debug('[OutputViewer] Output rendered successfully', { format });

    } catch (error) {
      this.log.error('[OutputViewer] Load output failed:', error);
      this._renderError(error);
    }
  }

  /**
   * Clear output
   */
  clear() {
    // BUG OV-4 FIX: Guard against post-dispose calls
    if (this._isDisposed) return;
    if (this.contentContainer) {
      this.contentContainer.innerHTML = '';
      this.contentContainer.dataset.renderedFormat = '';
    }
    this.currentData = null;
    this.currentArtifactId = null;
    this.currentFormat = CONFIG.DEFAULT_FORMAT;
    this._shouldAutoScroll = true; // BUG OV-6 FIX: Reset auto-scroll state on clear

    // Clear tabs
    this.tabs.clear();
    this.activeTabId = null;
    if (this.tabsHeader) {
      this.tabsHeader.innerHTML = '';
      this.tabsHeader.style.display = 'none';
    }

    this.log.debug('[OutputViewer] Cleared output');
  }

  /**
   * Get current output data
   * @returns {*}
   */
  getOutput() {
    return this.currentData;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Initialize renderers
   * @private
   */
  _initializeRenderers() {
    // Create renderer instances
    this.renderers.set(CONFIG.FORMATS.HTML, new HtmlRenderer());
    this.renderers.set(CONFIG.FORMATS.MARKDOWN, new MarkdownRenderer());
    this.renderers.set(CONFIG.FORMATS.JSON, new JsonRenderer());
    this.renderers.set(CONFIG.FORMATS.IMAGE, new MediaRenderer());
    this.renderers.set(CONFIG.FORMATS.VIDEO, new MediaRenderer());
    this.renderers.set(CONFIG.FORMATS.AUDIO, new MediaRenderer());
    this.renderers.set(CONFIG.FORMATS.MEDIA, new MediaRenderer());
    this.renderers.set('search_results', new SearchResultsRenderer());

    this.log.debug('[OutputViewer] Renderers initialized');
  }

  /**
   * Create DOM element structure
   * @private
   */
  _createElement() {
    // Add container class
    this.container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', 'Artifacts output panel');

    // Create tabs header
    this.tabsHeader = document.createElement('div');
    this.tabsHeader.className = 'output-tabs-header';
    this.container.appendChild(this.tabsHeader);

    // Create unified controls bar (format + actions)
    this.controlsContainer = document.createElement('div');
    this.controlsContainer.className = `${CONFIG.CLASS_NAMES.CONTROLS} output-controls`;

    // Format selector group
    const formatLabel = document.createElement('label');
    formatLabel.textContent = 'Format:';
    
    this.formatSelect = document.createElement('select');
    this.formatSelect.className = CONFIG.CLASS_NAMES.FORMAT_SELECT;

    const formats = [
      { value: CONFIG.FORMATS.TEXT, label: 'Text' },
      { value: CONFIG.FORMATS.HTML, label: 'HTML' },
      { value: CONFIG.FORMATS.MARKDOWN, label: 'Markdown' },
      { value: CONFIG.FORMATS.JSON, label: 'JSON' },
      { value: 'search_results', label: 'Search Results' },
      { value: CONFIG.FORMATS.IMAGE, label: 'Image' },
      { value: CONFIG.FORMATS.VIDEO, label: 'Video' },
      { value: CONFIG.FORMATS.AUDIO, label: 'Audio' },
    ];

    for (const fmt of formats) {
      const option = document.createElement('option');
      option.value = fmt.value;
      option.textContent = fmt.label;
      this.formatSelect.appendChild(option);
    }

    formatLabel.appendChild(this.formatSelect);
    this.controlsContainer.appendChild(formatLabel);

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    this.controlsContainer.appendChild(spacer);

    // Action buttons (right-aligned)
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy output';
    copyBtn.setAttribute('aria-label', 'Copy output to clipboard');
    copyBtn.addEventListener('click', this._handleCopyAll);
    this.controlsContainer.appendChild(copyBtn);
    this._eventListeners.push(() => copyBtn.removeEventListener('click', this._handleCopyAll));

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'Download';
    downloadBtn.title = 'Download output';
    downloadBtn.setAttribute('aria-label', 'Download output as file');
    downloadBtn.addEventListener('click', this._handleDownload);
    this.controlsContainer.appendChild(downloadBtn);
    this._eventListeners.push(() => downloadBtn.removeEventListener('click', this._handleDownload));

    this.exportPdfBtn = document.createElement('button');
    this.exportPdfBtn.textContent = 'Export PDF';
    this.exportPdfBtn.title = 'Export output as PDF';
    this.exportPdfBtn.setAttribute('aria-label', 'Export output as PDF document');
    this.exportPdfBtn.addEventListener('click', this._handleExportPdf);
    this.controlsContainer.appendChild(this.exportPdfBtn);
    this._eventListeners.push(() => this.exportPdfBtn.removeEventListener('click', this._handleExportPdf));

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear output';
    clearBtn.setAttribute('aria-label', 'Clear output display');
    clearBtn.addEventListener('click', this._handleClear);
    this.controlsContainer.appendChild(clearBtn);
    this._eventListeners.push(() => clearBtn.removeEventListener('click', this._handleClear));

    // Create content container
    this.contentContainer = document.createElement('div');
    this.contentContainer.className = CONFIG.CLASS_NAMES.CONTENT;
    if (this._wrapEnabled) {
      this.contentContainer.classList.add(CONFIG.CLASS_NAMES.WRAP_ACTIVE);
    }
    this.contentContainer.setAttribute('tabindex', '0');

    // Create floating scroll-to-bottom button
    this.scrollToBottomBtn = document.createElement('button');
    this.scrollToBottomBtn.className = 'ov-scroll-bottom-btn hidden';
    // BUG OV-6 FIX: Clearer button text (was "New Output" which implied creating output)
    this.scrollToBottomBtn.innerHTML = '<i class="fas fa-chevron-down"></i> Latest Output';
    this.scrollToBottomBtn.title = 'Jump to latest output';
    this.scrollToBottomBtn.setAttribute('aria-label', 'Jump to latest output'); // BUG OV-6 FIX: Accessibility
    this.scrollToBottomBtn.addEventListener('click', this._scrollToBottom);
    this._eventListeners.push(() => this.scrollToBottomBtn.removeEventListener('click', this._scrollToBottom));

    // Append to container
    this.container.appendChild(this.controlsContainer);
    this.container.appendChild(this.contentContainer);
    this.container.appendChild(this.scrollToBottomBtn);

    // Setup scroll listener for auto-scroll tracking
    this.contentContainer.addEventListener('scroll', this._handleScroll);
    this._eventListeners.push(() => {
      this.contentContainer.removeEventListener('scroll', this._handleScroll);
    });

    // BUG OV-5 FIX: Robust auto-scrolling with ResizeObserver to handle async DOM changes (like images)
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => {
        if (this._shouldAutoScroll) {
          this._scrollToBottom();
        }
      });
      this._resizeObserver.observe(this.contentContainer);
      this._eventListeners.push(() => {
        if (this._resizeObserver) {
          this._resizeObserver.disconnect();
          this._resizeObserver = null;
        }
      });
    }

    // Setup format change listener
    this.formatSelect.addEventListener('change', this._handleFormatChange);
    this._eventListeners.push(() => {
      this.formatSelect.removeEventListener('change', this._handleFormatChange);
    });

    // Global link click interceptor for markdown/HTML content
    this._handleLinkClick = this._handleLinkClick.bind(this);
    this.contentContainer.addEventListener('click', this._handleLinkClick);
    this._eventListeners.push(() => {
      this.contentContainer.removeEventListener('click', this._handleLinkClick);
    });

    this.log.debug('[OutputViewer] DOM structure created');
  }

  /**
   * Intercept clicks on links in output (markdown/html)
   * @private
   */
  _handleLinkClick(e) {
    const link = e.target.closest('a');
    if (!link || !link.href) return;

    // Output Viewer handles local files securely via aether bridge
    const isHttp = link.href.startsWith('http://') || link.href.startsWith('https://');
    const isMailto = link.href.startsWith('mailto:');
    
    if (!isHttp && !isMailto) {
      e.preventDefault();
      try {
        const { getAether } = require('../../../shared/bridge/AetherBridge');
        const aether = getAether();
        if (aether && aether.artifacts && aether.artifacts.openFile) {
          // Send the raw href (e.g. file:///path or /path)
          // Decode URI component to handle spaces (%20) in local file paths
          const cleanPath = decodeURIComponent(link.href.replace(/^file:\/\//i, ''));
          aether.artifacts.openFile(cleanPath);
        }
      } catch (err) {
        this.log.error('Failed to open local file link from output', { href: link.href, error: err });
      }
    }
  }

  static _sanitizeJsonString(str) {
    if (!str) return str;
    let inString = false;
    let isEscaped = false;
    let result = '';
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (inString) {
        if (char === '\n') result += '\\n';
        else if (char === '\r') result += '\\r';
        else if (char === '\t') result += '\\t';
        else if (char === '\\') {
          isEscaped = !isEscaped;
          result += char;
        } else if (char === '"' && !isEscaped) {
          inString = false;
          result += char;
        } else {
          isEscaped = false;
          result += char;
        }
      } else {
        if (char === '"') inString = true;
        result += char;
      }
    }
    return result;
  }

  /**
   * Detect output format from data
   * @param {*} data - Output data
   * @returns {string} Detected format
   * @private
   */
  _detectFormat(data) {
    // PRIORITY 1: Check for search results (premium display)
    if (typeof data === 'object' && SearchResultsRenderer.isSearchResults(data)) {
      return 'search_results';
    }
    
    if (typeof data === 'string') {
      const trimmed = data.trim();
      
      // Check for search results in JSON string
      if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
        let parsed = null;
        try {
          parsed = JSON.parse(trimmed);
        } catch (e) {
          // LLM outputs and Python dict reprs often contain unescaped newlines in string literals
          // Try robust sanitization (escape newlines only inside string literals)
          try {
            const sanitized = OutputViewer._sanitizeJsonString(trimmed);
            parsed = JSON.parse(sanitized);
          } catch (e2) {
            // Try Python dict format fix (single quotes, True/False/None)
            try {
              let fixed = trimmed.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (match, p1) => {
                return '"' + p1.replace(/"/g, '\\"') + '"';
              });
              fixed = fixed.replace(/\bTrue\b/g, 'true')
                           .replace(/\bFalse\b/g, 'false')
                           .replace(/\bNone\b/g, 'null');
              const sanitizedFixed = OutputViewer._sanitizeJsonString(fixed);
              parsed = JSON.parse(sanitizedFixed);
            } catch (e3) {
              // Still fails, but looks strongly like JSON
              if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
                  (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                return CONFIG.FORMATS.JSON;
              }
            }
          }
        }
        
        if (parsed) {
          if (SearchResultsRenderer.isSearchResults(parsed)) {
            return 'search_results';
          }
          return CONFIG.FORMATS.JSON;
        }
      }

      // Check for HTML content (anywhere in string, not just start/end)
      // Tool outputs often contain HTML tags even if they start with line numbers
      // Legacy format: "1<div...2<span..." (Jupyter adds line numbers)
      const hasHtmlTags = /<\w+[^>]*>[\s\S]*<\/\w+>/.test(data) || 
                         /<\w+[^>]*\/>/.test(data) ||
                         /(?:^|\n)\d*<(?:div|span|code|strong|p|h\d|table|ul|ol|li|a)/i.test(data);
      
      if (hasHtmlTags) {
        return CONFIG.FORMATS.HTML;
      }

      // Check for Markdown indicators (before defaulting to text)
      // Strong indicators: any ONE of these is sufficient for markdown detection
      const strongMd = /^#{1,6}\s/m.test(data) ||     // heading at line start
                       data.includes('```') ||         // code fence
                       data.includes('**') ||          // bold
                       /^\|.+\|/m.test(data) ||        // table row
                       /^>\s/m.test(data);             // blockquote

      if (strongMd) {
        return CONFIG.FORMATS.MARKDOWN;
      }

      // Medium indicators: repeated list patterns (2+ matches) are strong
      // enough on their own — tool outputs frequently return bullet lists
      const bulletMatches = (data.match(/^[-*]\s/gm) || []).length;
      const numberedMatches = (data.match(/^\d+\.\s/gm) || []).length;
      if (bulletMatches >= 2 || numberedMatches >= 2) {
        return CONFIG.FORMATS.MARKDOWN;
      }

      // Weak indicators: need 2+ distinct types to trigger (avoids false
      // positives from plain text containing a single dash or backtick)
      let weakMdCount = 0;
      if (bulletMatches >= 1) weakMdCount++;             // single list item
      if (numberedMatches >= 1) weakMdCount++;           // single numbered item
      if (/`.+`/.test(data)) weakMdCount++;              // inline code
      if (/\[.+\]\(.+\)/.test(data)) weakMdCount++;     // markdown link

      if (weakMdCount >= 2) {
        return CONFIG.FORMATS.MARKDOWN;
      }

      const mediaFormat = this._detectMediaFormatFromUrl(data);
      if (mediaFormat) {
        return mediaFormat;
      }

      return CONFIG.FORMATS.TEXT;
    }

    // Object/Array - assume JSON
    if (typeof data === 'object') {
      return CONFIG.FORMATS.JSON;
    }

    return CONFIG.FORMATS.TEXT;
  }

  _detectMediaFormatFromUrl(value) {
    if (!value || typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const lower = trimmed.toLowerCase();
    if (lower.startsWith('data:image/')) return CONFIG.FORMATS.IMAGE;
    if (lower.startsWith('data:video/')) return CONFIG.FORMATS.VIDEO;
    if (lower.startsWith('data:audio/')) return CONFIG.FORMATS.AUDIO;

    let path = '';
    try {
      const parsed = new URL(trimmed, 'http://localhost');
      path = (parsed.pathname || '').toLowerCase();
    } catch (_) {
      path = trimmed.split(/[?#]/)[0].toLowerCase();
    }

    const segment = path.split('/').pop() || '';
    if (!segment.includes('.')) {
      return null;
    }

    const ext = segment.split('.').pop();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
      return CONFIG.FORMATS.IMAGE;
    }
    if (['mp4', 'webm', 'ogg', 'mov'].includes(ext)) {
      return CONFIG.FORMATS.VIDEO;
    }
    if (['mp3', 'wav', 'ogg', 'aac'].includes(ext)) {
      return CONFIG.FORMATS.AUDIO;
    }

    return null;
  }

  /**
   * Render data with appropriate renderer
   * @param {*} data - Data to render
   * @param {string} format - Format to render as
   * @private
   */
  async _render(data, format) {
    // CRITICAL: Validate contentContainer exists
    if (!this.contentContainer) {
      this.log.error('[OutputViewer] contentContainer is null - cannot render output!');
      return;
    }
    
    // UX FIX: Only clear content if format changed to avoid destructive DOM thrashing
    // Individual renderers are responsible for smart-updating or clearing their own content
    if (this.contentContainer.dataset.renderedFormat !== format) {
      this.contentContainer.innerHTML = '';
      this.contentContainer.dataset.renderedFormat = format;
    }

    // Get renderer
    const renderer = this.renderers.get(format);

    if (renderer) {
      // Use specialized renderer
      this.log.debug('[OutputViewer] Using specialized renderer', { format });
      await renderer.render(data, this.contentContainer);
    } else {
      // Fallback to text rendering
      this.log.debug('[OutputViewer] Using fallback text renderer', { format });
      this._renderText(data);
    }
    
    // Verify content was rendered
    if (this.contentContainer.children.length === 0 && !this.contentContainer.textContent) {
      this.log.warn('[OutputViewer] Content container is empty after render!', { format, dataType: typeof data });
    } else {
      this.log.debug('[OutputViewer] Output rendered successfully', { format });
    }
  }

  /**
   * Render as plain text (fallback)
   * @param {*} data - Data to render
   * @private
   */
  _renderText(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    
    let pre = this.contentContainer.querySelector('.output-plain-pre');
    if (!pre) {
      this.contentContainer.innerHTML = '';
      pre = document.createElement('pre');
      pre.className = 'output-plain-pre';
      this.contentContainer.appendChild(pre);
    }
    
    // UX FIX: Only update textContent to avoid DOM destruction
    if (pre.textContent !== text) {
      pre.textContent = text;
    }
  }

  /**
   * Render error message
   * @param {Error} error - Error to display
   * @private
   */
  _renderError(error) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'output-error-card';
    errorDiv.textContent = `Error: ${error.message}`;
    
    this.contentContainer.innerHTML = '';
    this.contentContainer.appendChild(errorDiv);
  }

  /**
   * Check if we are at the bottom to decide if we should auto-scroll (BUG OV-5 FIX)
   * @private
   */
  _checkAutoScroll() {
    if (!this.contentContainer) return;

    const { scrollTop, scrollHeight, clientHeight } = this.contentContainer;
    // BUG OV-6 FIX: Use unified threshold for consistent "at bottom" detection
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    this._shouldAutoScroll = distanceFromBottom < CONFIG.SCROLL_THRESHOLD;
    this.log.debug(`[OutputViewer] shouldAutoScroll: ${this._shouldAutoScroll}`, {
      scrollTop,
      scrollHeight,
      clientHeight,
      distanceFromBottom
    });
  }

  /**
   * Perform auto-scroll if enabled, or show the button (BUG OV-5 FIX)
   * @private
   */
  _performAutoScroll() {
    if (!this.contentContainer) return;

    if (this._shouldAutoScroll) {
      this._scrollToBottom();
    } else {
      this._updateScrollButtonVisibility();
    }
  }

  /**
   * Scroll output to bottom
   * @private
   */
  _scrollToBottom() {
    if (this.contentContainer) {
      // Use requestAnimationFrame to ensure layout has updated after content change
      requestAnimationFrame(() => {
        if (this._isDisposed) return; // Guard against dispose during frame render
        if (this.contentContainer) {
          this.contentContainer.scrollTop = this.contentContainer.scrollHeight;
          this._updateScrollButtonVisibility();
        }
      });
    }
  }

  /**
   * Update visibility of the "Scroll to bottom" button
   * @private
   */
  _updateScrollButtonVisibility() {
    if (!this.scrollToBottomBtn || !this.contentContainer) return;

    const { scrollTop, scrollHeight, clientHeight } = this.contentContainer;
    // BUG OV-6 FIX: Use unified threshold for consistent "at bottom" detection
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isAtBottom = distanceFromBottom < CONFIG.SCROLL_THRESHOLD;
    const hasScroll = scrollHeight > clientHeight;

    if (hasScroll && !isAtBottom) {
      this.scrollToBottomBtn.classList.remove('hidden');
    } else {
      this.scrollToBottomBtn.classList.add('hidden');
    }
  }

  /**
   * Handle scroll events to update button and state
   * @private
   */
  _handleScroll() {
    this._updateScrollButtonVisibility();
  }

  /**
   * Handle format change
   * @private
   */
  _handleFormatChange() {
    if (!this.currentData) {
      return;
    }

    const newFormat = this.formatSelect.value;
    this.loadOutput(this.currentData, newFormat);
  }

  /**
   * Handle clear button click
   * @private
   */
  _handleClear() {
    this.clear();
  }

  /**
   * Handle copy all
   * @private
   */
  async _handleCopyAll() {
    try {
      const text = this._getCopyText(this.currentFormat, this.currentData);
      await navigator.clipboard.writeText(text);
    } catch (e) {
      this.log.error('[OutputViewer] Copy failed:', e);
    }
  }

  /**
   * Handle download
   * @private
   */
  _handleDownload() {
    try {
      const { mime, ext, content } = this._getDownloadPayload(this.currentFormat, this.currentData);
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date();
      const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
      const name = `artifact-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.${ext}`;
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      this.log.error('[OutputViewer] Download failed:', e);
    }
  }

  /**
   * Handle export as PDF
   * @private
   */
  async _handleExportPdf() {
    if (!this.currentData) return;

    const html = ContentExporter.generateContentHtml(
      this.currentData,
      'Artifact Output',
      this.currentFormat
    );
    const ts = new Date();
    const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
    const filename = `artifact-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.pdf`;
    await ContentExporter.exportAsPdf(html, filename);
  }

  /**
   * Toggle line wrap
   * @private
   */
  _handleToggleWrap() {
    this._wrapEnabled = !this._wrapEnabled;
    if (!this.contentContainer) return;
    
    if (this._wrapEnabled) {
      this.contentContainer.classList.add(CONFIG.CLASS_NAMES.WRAP_ACTIVE);
    } else {
      this.contentContainer.classList.remove(CONFIG.CLASS_NAMES.WRAP_ACTIVE);
    }
    
    // Markdown renderer uses nested content with same class name
    const markdownContent = this.contentContainer.querySelector('.markdown-content');
    if (markdownContent) {
      if (this._wrapEnabled) {
        markdownContent.classList.add(CONFIG.CLASS_NAMES.WRAP_ACTIVE);
      } else {
        markdownContent.classList.remove(CONFIG.CLASS_NAMES.WRAP_ACTIVE);
      }
    }
  }

  _getCopyText(format, data) {
    if (data == null) return '';
    switch (format) {
      case CONFIG.FORMATS.JSON:
        try { return typeof data === 'string' ? JSON.stringify(JSON.parse(data), null, 2) : JSON.stringify(data, null, 2); } catch { return String(data); }
      case CONFIG.FORMATS.MARKDOWN:
        if (typeof data === 'string') return data;
        if (data && typeof data === 'object' && (data.markdown || data.content)) return data.markdown || data.content;
        return this.contentContainer ? this.contentContainer.textContent || '' : '';
      case CONFIG.FORMATS.HTML:
        return this.contentContainer ? this.contentContainer.textContent || '' : '';
      default:
        return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    }
  }

  _getDownloadPayload(format, data) {
    if (data == null) return { mime: 'text/plain', ext: 'txt', content: '' };
    switch (format) {
      case CONFIG.FORMATS.JSON: {
        let content = '';
        try { content = typeof data === 'string' ? JSON.stringify(JSON.parse(data), null, 2) : JSON.stringify(data, null, 2); } catch { content = String(data); }
        return { mime: 'application/json', ext: 'json', content };
      }
      case CONFIG.FORMATS.MARKDOWN: {
        const content = typeof data === 'string' ? data : (data.markdown || data.content || String(data));
        return { mime: 'text/markdown', ext: 'md', content };
      }
      case CONFIG.FORMATS.HTML: {
        const rawHtml = typeof data === 'string' ? data : String(data);
        const content = typeof ContentExporter.sanitizeOutputHtml === 'function'
          ? ContentExporter.sanitizeOutputHtml(rawHtml, { mode: 'direct', allowScripts: false })
          : rawHtml;
        return { mime: 'text/html', ext: 'html', content };
      }
      default: {
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return { mime: 'text/plain', ext: 'txt', content };
      }
    }
  }

  _setupAccessibility() {
    try {
      if (this.controlsContainer) {
        this.controlsContainer.setAttribute('role', 'toolbar');
        this.controlsContainer.setAttribute('aria-label', 'Output format controls');
      }
      if (this.toolbarContainer) {
        this.toolbarContainer.setAttribute('role', 'toolbar');
        this.toolbarContainer.setAttribute('aria-label', 'Output actions');
      }
      if (this.contentContainer) {
        this.contentContainer.setAttribute('role', 'document');
        this.contentContainer.setAttribute('aria-live', 'polite');
      }
    } catch (error) {
      if (this.log) this.log.trace('[OutputViewer] _setupAccessibility non-critical error:', error?.message);
    }
  }

  /**
   * Inject styles (minimal - most styles now in artifacts.css)
   * @private
   */
  _injectStyles() {
    const styleId = 'output-viewer-styles';

    if (document.getElementById(styleId)) {
      return;
    }

    // Only inject container layout — .output-content and .wrap-lines rules
    // are already defined in artifacts.css (single source of truth).
    const styles = `
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }
      
      /* Output Tabs Header */
      .output-tabs-header {
        display: flex;
        gap: 4px;
        padding: 6px 8px;
        background: transparent;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        overflow-x: auto;
        flex-shrink: 0;
      }
      .output-tab-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        font-size: var(--font-size-xs, 12px);
        font-weight: var(--font-weight-medium, 500);
        color: var(--color-text-tertiary, #666);
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--radius-md, 6px);
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        white-space: nowrap;
      }
      .output-tab-btn:hover {
        color: var(--color-text-primary, #e8e8e8);
        background: rgba(255, 255, 255, 0.06);
      }
      .output-tab-btn.active {
        color: var(--color-text-primary, #e8e8e8);
        background: rgba(255, 255, 255, 0.08);
        font-weight: var(--font-weight-semibold, 600);
      }
    `;

    const styleElement = document.createElement('style');
    styleElement.id = styleId;
    styleElement.textContent = styles;
    document.head.appendChild(styleElement);

    this.log.debug('[OutputViewer] Styles injected');
  }
}

// Export
module.exports = OutputViewer;

if (typeof window !== 'undefined') {
  window.OutputViewer = OutputViewer;
}
