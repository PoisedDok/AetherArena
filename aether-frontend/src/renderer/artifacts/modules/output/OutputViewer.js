'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController (loadOutput method), IPC 'artifacts:load-output' events --- {artifact_types.console_output | artifact_types.html_output, json}
 * Processing: Auto-detect format (HTML/Markdown/JSON/Media), route to specialized renderer (HtmlRenderer|MarkdownRenderer|JsonRenderer|MediaRenderer), manage renderer lifecycle, handle format switching --- {5 jobs: JOB_CREATE_DOM_ELEMENT, JOB_DELEGATE_TO_MODULE, JOB_ROUTE_BY_TYPE, JOB_EMIT_EVENT, JOB_UPDATE_STATE}
 * Outgoing: DOM (rendered output), HtmlRenderer|MarkdownRenderer|JsonRenderer|MediaRenderer.render(), EventBus --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/output/OutputViewer
 */

const { EventTypes } = require('../../../../core/events/EventTypes');
const HtmlRenderer = require('./renderers/HtmlRenderer');
const MarkdownRenderer = require('./renderers/MarkdownRenderer');
const JsonRenderer = require('./renderers/JsonRenderer');
const MediaRenderer = require('./renderers/MediaRenderer');
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
    CONTENT: 'output-content',
    FORMAT_SELECT: 'format-select',
  }),
  DEFAULT_FORMAT: 'text',
});

class OutputViewer {
  /**
   * Create output viewer
   * @param {Object} options - Configuration options
   * @param {Object} options.controller - Artifacts controller instance
   * @param {Object} options.eventBus - Event bus for communication
   */
  constructor(options = {}) {
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
    this.contentContainer = null;
    this.formatSelect = null;

    // Renderers
    this.renderers = new Map();
    this._initializeRenderers();

    // State
    this.currentFormat = CONFIG.DEFAULT_FORMAT;
    this.currentData = null;

    // Event handlers (for cleanup)
    this._eventListeners = [];

    // Bind methods
    this._handleFormatChange = this._handleFormatChange.bind(this);
    this._handleClear = this._handleClear.bind(this);
  }

  /**
   * Initialize output viewer
   * @param {HTMLElement} container - Container pane element
   */
  async init(container) {
    console.log('📊 OutputViewer: Initializing...');

    try {
      if (!container) {
        throw new Error('[OutputViewer] Container required');
      }

      this.container = container;

      // Create DOM structure
      this._createElement();

      // Inject styles
      this._injectStyles();

      // Emit ready event
      this.eventBus.emit(EventTypes.UI.COMPONENT_READY, { 
        component: 'OutputViewer',
        timestamp: Date.now()
      });

      console.log('✅ OutputViewer: Initialized');

    } catch (error) {
      console.error('❌ OutputViewer: Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Dispose output viewer and cleanup
   */
  dispose() {
    console.log('🛑 OutputViewer: Disposing...');

    // Dispose renderers
    for (const [, renderer] of this.renderers) {
      if (renderer && typeof renderer.dispose === 'function') {
        try {
          renderer.dispose();
        } catch (error) {
          console.error('[OutputViewer] Failed to dispose renderer:', error);
        }
      }
    }
    this.renderers.clear();

    // Remove event listeners
    for (const cleanup of this._eventListeners) {
      try {
        cleanup();
      } catch (error) {
        console.error('[OutputViewer] Failed to cleanup event listener:', error);
      }
    }
    this._eventListeners = [];

    // Clear references
    this.container = null;
    this.controlsContainer = null;
    this.contentContainer = null;
    this.formatSelect = null;

    console.log('✅ OutputViewer: Disposed');
  }

  /**
   * Load output content
   * @param {*} data - Output data to display
   * @param {string} format - Optional format override
   */
  async loadOutput(data, format = null) {
    try {
      // Store data
      this.currentData = data;

      // Detect format if not provided
      if (!format) {
        format = this._detectFormat(data);
      }

      this.currentFormat = format;

      // Update format select
      if (this.formatSelect) {
        this.formatSelect.value = format;
      }

      // Render with appropriate renderer
      await this._render(data, format);

      // Emit event
      this.eventBus.emit(EventTypes.ARTIFACTS.OUTPUT_LOADED, { 
        format,
        size: typeof data === 'string' ? data.length : JSON.stringify(data).length,
        timestamp: Date.now()
      });

      console.log(`[OutputViewer] Loaded output: ${format}`);

    } catch (error) {
      console.error('[OutputViewer] Load output failed:', error);
      this._renderError(error);
    }
  }

  /**
   * Clear output
   */
  clear() {
    if (this.contentContainer) {
      this.contentContainer.innerHTML = '';
    }
    this.currentData = null;
    this.currentFormat = CONFIG.DEFAULT_FORMAT;

    console.log('[OutputViewer] Cleared output');
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

    console.log('[OutputViewer] Renderers initialized');
  }

  /**
   * Create DOM element structure
   * @private
   */
  _createElement() {
    // Add container class
    this.container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);

    // Create controls
    this.controlsContainer = document.createElement('div');
    this.controlsContainer.className = CONFIG.CLASS_NAMES.CONTROLS;

    // Create format select
    const formatLabel = document.createElement('label');
    formatLabel.textContent = 'Format: ';
    
    this.formatSelect = document.createElement('select');
    this.formatSelect.className = CONFIG.CLASS_NAMES.FORMAT_SELECT;

    // Add format options
    const formats = [
      { value: CONFIG.FORMATS.TEXT, label: 'Text' },
      { value: CONFIG.FORMATS.HTML, label: 'HTML' },
      { value: CONFIG.FORMATS.MARKDOWN, label: 'Markdown' },
      { value: CONFIG.FORMATS.JSON, label: 'JSON' },
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

    // Create clear button
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear output';
    clearBtn.addEventListener('click', this._handleClear);
    this.controlsContainer.appendChild(clearBtn);

    this._eventListeners.push(() => {
      clearBtn.removeEventListener('click', this._handleClear);
    });

    // Create content container
    this.contentContainer = document.createElement('div');
    this.contentContainer.className = CONFIG.CLASS_NAMES.CONTENT;

    // Append to container
    this.container.appendChild(this.controlsContainer);
    this.container.appendChild(this.contentContainer);

    // Setup format change listener
    this.formatSelect.addEventListener('change', this._handleFormatChange);
    this._eventListeners.push(() => {
      this.formatSelect.removeEventListener('change', this._handleFormatChange);
    });

    console.log('[OutputViewer] DOM structure created');
  }

  /**
   * Detect output format from data
   * @param {*} data - Output data
   * @returns {string} Detected format
   * @private
   */
  _detectFormat(data) {
    if (typeof data === 'string') {
      // Check for HTML
      if (data.trim().startsWith('<') && data.trim().endsWith('>')) {
        return CONFIG.FORMATS.HTML;
      }

      // Check for JSON
      if ((data.trim().startsWith('{') || data.trim().startsWith('['))) {
        try {
          JSON.parse(data);
          return CONFIG.FORMATS.JSON;
        } catch (e) {
          // Not JSON
        }
      }

      // Check for Markdown
      if (data.includes('##') || data.includes('```') || data.includes('**')) {
        return CONFIG.FORMATS.MARKDOWN;
      }

      // Check for media URLs
      const lowerData = data.toLowerCase();
      if (lowerData.match(/\.(jpg|jpeg|png|gif|webp|svg)$/)) {
        return CONFIG.FORMATS.IMAGE;
      }
      if (lowerData.match(/\.(mp4|webm|ogg|mov)$/)) {
        return CONFIG.FORMATS.VIDEO;
      }
      if (lowerData.match(/\.(mp3|wav|ogg|aac)$/)) {
        return CONFIG.FORMATS.AUDIO;
      }

      return CONFIG.FORMATS.TEXT;
    }

    // Object/Array - assume JSON
    if (typeof data === 'object') {
      return CONFIG.FORMATS.JSON;
    }

    return CONFIG.FORMATS.TEXT;
  }

  /**
   * Render data with appropriate renderer
   * @param {*} data - Data to render
   * @param {string} format - Format to render as
   * @private
   */
  async _render(data, format) {
    // Clear content
    this.contentContainer.innerHTML = '';

    // Get renderer
    const renderer = this.renderers.get(format);

    if (renderer) {
      // Use specialized renderer
      await renderer.render(data, this.contentContainer);
    } else {
      // Fallback to text rendering
      this._renderText(data);
    }
  }

  /**
   * Render as plain text (fallback)
   * @param {*} data - Data to render
   * @private
   */
  _renderText(data) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'padding: 16px; margin: 0; font-family: var(--font-family-mono, "Courier New", monospace); font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; color: rgba(255, 255, 255, 0.95);';
    
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    pre.textContent = text;

    this.contentContainer.appendChild(pre);
  }

  /**
   * Render error message
   * @param {Error} error - Error to display
   * @private
   */
  _renderError(error) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding: 16px; color: #d32f2f; background: #ffebee; border: 1px solid #ef9a9a; border-radius: 4px;';
    errorDiv.textContent = `Error: ${error.message}`;
    
    this.contentContainer.innerHTML = '';
    this.contentContainer.appendChild(errorDiv);
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
   * Inject styles
   * @private
   */
  _injectStyles() {
    const styleId = 'output-viewer-styles';

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
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 12px;
        background: rgba(25, 25, 30, 0.9);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        flex-shrink: 0;
      }

      .${CONFIG.CLASS_NAMES.CONTROLS} label {
        font-size: 13px;
        color: rgba(255, 255, 255, 0.8);
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .${CONFIG.CLASS_NAMES.FORMAT_SELECT} {
        padding: 4px 8px;
        font-size: 13px;
        color: rgba(255, 255, 255, 0.9);
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        outline: none;
      }

      .${CONFIG.CLASS_NAMES.FORMAT_SELECT}:focus {
        border-color: rgba(255, 255, 255, 0.4);
      }

      .${CONFIG.CLASS_NAMES.CONTROLS} button {
        padding: 6px 12px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.85);
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        cursor: pointer;
        transition: all 200ms ease;
      }

      .${CONFIG.CLASS_NAMES.CONTROLS} button:hover {
        color: rgba(255, 255, 255, 0.98);
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.3);
      }

      .${CONFIG.CLASS_NAMES.CONTENT} {
        flex: 1;
        overflow: auto;
        background: rgba(10, 10, 10, 0.6);
        padding: 12px;
      }
    `;

    const styleElement = document.createElement('style');
    styleElement.id = styleId;
    styleElement.textContent = styles;
    document.head.appendChild(styleElement);

    console.log('[OutputViewer] Styles injected');
  }
}

// Export
module.exports = OutputViewer;

if (typeof window !== 'undefined') {
  window.OutputViewer = OutputViewer;
  console.log('📦 OutputViewer loaded');
}

