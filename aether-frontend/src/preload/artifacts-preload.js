'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron ipcRenderer (from main process) --- {object, javascript_api}
 * Processing: Load libraries (highlight.js 21 languages, marked, DOMPurify), create secure IPC bridge with validation, freeze API objects, expose to renderer via contextBridge --- {6 jobs: JOB_ATTACH_TO_WINDOW, JOB_CREATE_BRIDGE, JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_INITIALIZE, JOB_SEND_IPC}
 * Outgoing: window.aether, window.hljs, window.marked, window.sanitizer (exposed to renderer) --- {object, javascript_api}
 * 
 * @module preload/artifacts-preload
 * 
 * Artifacts Window Preload Script
 * ============================================================================
 * Secure preload for artifacts window.
 * Exposes IPC bridge, syntax highlighting, markdown, sanitization, and storage.
 * 
 * Security:
 * - contextIsolation enabled
 * - Channel whitelisting
 * - Payload validation
 * - Rate limiting
 * - HTML sanitization
 * 
 * Libraries:
 * - highlight.js (21 languages) for syntax highlighting
 * - marked for markdown parsing
 * - DOMPurify for HTML sanitization
 * - Storage API for PostgreSQL persistence
 */

const { contextBridge, ipcRenderer } = require('electron');
const { createBridge } = require('./common/bridge-factory');
const { freeze } = Object;

// ============================================================================
// Load Libraries
// ============================================================================

// Load highlight.js with comprehensive language support
let hljs = null;
try {
  hljs = require('highlight.js/lib/core');
  
  // Register comprehensive language set
  hljs.registerLanguage('javascript', require('highlight.js/lib/languages/javascript'));
  hljs.registerLanguage('typescript', require('highlight.js/lib/languages/typescript'));
  hljs.registerLanguage('python', require('highlight.js/lib/languages/python'));
  hljs.registerLanguage('java', require('highlight.js/lib/languages/java'));
  hljs.registerLanguage('c', require('highlight.js/lib/languages/c'));
  hljs.registerLanguage('cpp', require('highlight.js/lib/languages/cpp'));
  hljs.registerLanguage('csharp', require('highlight.js/lib/languages/csharp'));
  hljs.registerLanguage('go', require('highlight.js/lib/languages/go'));
  hljs.registerLanguage('rust', require('highlight.js/lib/languages/rust'));
  hljs.registerLanguage('ruby', require('highlight.js/lib/languages/ruby'));
  hljs.registerLanguage('php', require('highlight.js/lib/languages/php'));
  hljs.registerLanguage('swift', require('highlight.js/lib/languages/swift'));
  hljs.registerLanguage('kotlin', require('highlight.js/lib/languages/kotlin'));
  hljs.registerLanguage('bash', require('highlight.js/lib/languages/bash'));
  hljs.registerLanguage('shell', require('highlight.js/lib/languages/shell'));
  hljs.registerLanguage('sql', require('highlight.js/lib/languages/sql'));
  hljs.registerLanguage('json', require('highlight.js/lib/languages/json'));
  hljs.registerLanguage('yaml', require('highlight.js/lib/languages/yaml'));
  hljs.registerLanguage('xml', require('highlight.js/lib/languages/xml'));
  hljs.registerLanguage('html', require('highlight.js/lib/languages/xml'));
  hljs.registerLanguage('css', require('highlight.js/lib/languages/css'));
  hljs.registerLanguage('markdown', require('highlight.js/lib/languages/markdown'));
  
  // Configure
  hljs.configure({ ignoreUnescapedHTML: true });
  
  console.log('[ArtifactsPreload] highlight.js loaded with 21 languages');
} catch (error) {
  console.error('[ArtifactsPreload] Failed to load highlight.js:', error);
}

// Load marked (markdown parser)
let marked = null;
try {
  // Direct require - esbuild will bundle it
  marked = require('marked');
    
    // Configure marked
  if (marked && marked.setOptions) {
      marked.setOptions({
        breaks: true,
        gfm: true,
        headerIds: false,
        mangle: false,
      });
    }
    
    console.log('[ArtifactsPreload] marked loaded successfully');
} catch (error) {
  console.error('[ArtifactsPreload] Failed to load marked:', error);
}

// Load sanitizer (DOMPurify wrapper)
let sanitizer = null;
try {
  let DOMPurify = require('dompurify');
  if (DOMPurify && DOMPurify.default) {
    DOMPurify = DOMPurify.default;
  }
  
  if (DOMPurify) {
    sanitizer = freeze({
      isAvailable: () => true,
      
      getInfo: () => ({
        available: true,
        version: DOMPurify.version || 'unknown',
        profiles: ['strict', 'default', 'permissive'],
      }),
      
      sanitizeHTML: (html = '', opts = {}) => {
        if (!html || typeof html !== 'string') return '';
        
        const profile = (opts.profile || 'strict').toLowerCase();
        const cfg = { ...opts };
        
        switch (profile) {
          case 'permissive':
            cfg.ALLOWED_TAGS = false;
            cfg.ALLOWED_ATTR = false;
            break;
          case 'default':
            cfg.ALLOWED_TAGS = ['b','i','em','strong','a','p','ul','ol','li','code','pre','br','span','div','img','h1','h2','h3','h4','h5','h6','blockquote'];
            cfg.ALLOWED_ATTR = ['href','src','alt','title','target','style','class'];
            break;
          case 'strict':
          default:
            cfg.ALLOWED_TAGS = ['b','i','em','strong','a','p','br','code','pre'];
            cfg.ALLOWED_ATTR = ['href','title','target'];
            break;
        }
        
        try {
          return DOMPurify.sanitize(html, cfg);
        } catch {
          return String(html).replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          }[char]));
        }
      },
    });
    
    console.log('[ArtifactsPreload] DOMPurify sanitizer loaded');
  }
} catch (error) {
  console.error('[ArtifactsPreload] Failed to load sanitizer:', error);
}

// Note: Storage API will be loaded in Phase 7 (Infrastructure Layer)
// For now, it's a placeholder that will be implemented when needed
const storageAPI = null;

// ============================================================================
// Create Secure IPC Bridge
// ============================================================================

const ipcBridge = createBridge({
  ipcRenderer,
  context: 'artifactsWindow',
  enableRateLimiting: true,
  enableSizeValidation: true,
  enablePayloadValidation: true,
  onError: (error, details) => {
    console.error('[ArtifactsPreload] IPC Error:', error.message, details);
  },
});

// ============================================================================
// Artifacts Window API
// ============================================================================

const aetherAPI = freeze({
  /**
   * Window identifier
   */
  window: 'artifacts',
  
  /**
   * IPC Communication
   */
  ipc: freeze({
    send: ipcBridge.send.bind(ipcBridge),
    on: ipcBridge.on.bind(ipcBridge),
    once: ipcBridge.once.bind(ipcBridge),
    removeListener: ipcBridge.removeListener.bind(ipcBridge),
    removeAllListeners: ipcBridge.removeAllListeners.bind(ipcBridge),
  }),
  
  /**
   * Window Controls
   */
  windowControl: freeze({
    /**
     * Control window
     * @param {string} action - minimize|maximize|close|toggle-visibility
     */
    control: (action) => {
      ipcBridge.send('artifacts:window-control', action);
    },
    
    /**
     * Report window state (active/inactive)
     * @param {boolean} isActive - Window has content
     */
    setState: (isActive) => {
      ipcBridge.send('artifacts:window-state', isActive);
    },
    
    /**
     * Report mode change
     * @param {string} mode - Current mode (code|output|files|storage|legal-news)
     */
    setMode: (mode) => {
      ipcBridge.send('artifacts:mode-changed', mode);
    },
  }),
  
  /**
   * Artifacts Operations
   */
  artifacts: freeze({
    /**
     * Export file
     * @param {string} content - File content
     * @param {string} name - File name
     * @param {string} extension - File extension
     */
    exportFile: (content, name, extension) => {
      ipcBridge.send('artifacts:file-export', { content, name, extension });
    },
    
    /**
     * Open file with system app
     * @param {string} path - File path
     */
    openFile: (path) => {
      ipcBridge.send('artifacts:open-file', { path });
    },
    
    /**
     * Listen for ensure visible
     * @param {Function} callback - Callback()
     * @returns {Function} Cleanup function
     */
    onEnsureVisible: (callback) => {
      return ipcBridge.on('artifacts:ensure-visible', callback);
    },
    
    /**
     * Listen for mode change
     * @param {Function} callback - Callback(mode)
     * @returns {Function} Cleanup function
     */
    onSetMode: (callback) => {
      return ipcBridge.on('artifacts:set-mode', callback);
    },
    
    /**
     * Listen for artifact stream
     * @param {Function} callback - Callback(data)
     * @returns {Function} Cleanup function
     */
    onStream: (callback) => {
      return ipcBridge.on('artifacts:stream', callback);
    },
    
    /**
     * Listen for focus artifacts
     * @param {Function} callback - Callback(artifactId, tab)
     * @returns {Function} Cleanup function
     */
    onFocus: (callback) => {
      return ipcBridge.on('artifacts:focus-artifacts', callback);
    },
    
    /**
     * Listen for tab switch
     * @param {Function} callback - Callback(tab)
     * @returns {Function} Cleanup function
     */
    onSwitchTab: (callback) => {
      return ipcBridge.on('artifacts:switch-tab', callback);
    },
    
    /**
     * Listen for chat switch
     * @param {Function} callback - Callback(chatId)
     * @returns {Function} Cleanup function
     */
    onSwitchChat: (callback) => {
      return ipcBridge.on('artifacts:switch-chat', callback);
    },
    
    /**
     * Listen for code load
     * @param {Function} callback - Callback(code, language, filename)
     * @returns {Function} Cleanup function
     */
    onLoadCode: (callback) => {
      return ipcBridge.on('artifacts:load-code', callback);
    },
    
    /**
     * Listen for output load
     * @param {Function} callback - Callback(output, format)
     * @returns {Function} Cleanup function
     */
    onLoadOutput: (callback) => {
      return ipcBridge.on('artifacts:load-output', callback);
    },
    
    /**
     * Listen for show artifact request
     * @param {Function} callback - Callback({ artifactId, tab })
     * @returns {Function} Cleanup function
     */
    onShowArtifact: (callback) => {
      return ipcBridge.on('artifacts:show-artifact', callback);
    },
  }),
  
  /**
   * Libraries
   */
  hljs,
  marked,
  sanitizer,
  storageAPI,
  
  /**
   * Logging
   */
  log: freeze({
    send: (message) => {
      if (typeof message === 'string' && message.length <= 10000) {
        ipcBridge.send('renderer-log', message);
      }
    },
  }),
  
  /**
   * Metadata
   */
  versions: freeze({
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  }),
  
  /**
   * Get bridge metadata
   */
  getMetadata: () => ipcBridge.getMetadata(),
  
  /**
   * Get bridge statistics
   */
  getStats: () => ipcBridge.getStats(),
});

// ============================================================================
// Expose API to Renderer
// ============================================================================

try {
  contextBridge.exposeInMainWorld('aether', aetherAPI);
  
  // Also expose libraries globally for convenience
  if (hljs) contextBridge.exposeInMainWorld('hljs', hljs);
  if (marked) contextBridge.exposeInMainWorld('marked', marked);
  if (sanitizer) contextBridge.exposeInMainWorld('sanitizer', sanitizer);
  if (storageAPI) contextBridge.exposeInMainWorld('storageAPI', storageAPI);
  
  console.log('[ArtifactsPreload] Artifacts window API exposed successfully', {
    hljs: !!hljs,
    marked: !!marked,
    sanitizer: !!sanitizer,
    storageAPI: !!storageAPI,
  });
} catch (error) {
  console.error('[ArtifactsPreload] Failed to expose API:', error);
  throw error;
}

