'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron ipcRenderer (from main process) --- {ipc_types.ipcRenderer, object}
 * Processing: Load libraries (highlight.js 6 languages, marked, DOMPurify, StorageAPI), create secure IPC bridge with validation, freeze API objects, expose to renderer via contextBridge --- {4 jobs: JOB_ATTACH_TO_WINDOW, JOB_CREATE_BRIDGE, JOB_GET_STATE, JOB_INITIALIZE}
 * Outgoing: window.aether, window.hljs, window.marked, window.sanitizer, window.storageAPI (exposed to renderer) --- {preload_types.contextBridge_api, frozen_object}
 * 
 * @module preload/chat-preload
 * 
 * Chat Window Preload Script
 * ============================================================================
 * Secure preload for chat window.
 * Exposes IPC bridge, syntax highlighting, markdown parsing, and sanitization.
 * 
 * Security:
 * - contextIsolation enabled
 * - Channel whitelisting
 * - Payload validation
 * - Rate limiting
 * - HTML sanitization
 * 
 * Libraries:
 * - highlight.js for syntax highlighting
 * - marked for markdown parsing
 * - DOMPurify for HTML sanitization
 */

const { contextBridge, ipcRenderer } = require('electron');
const { createBridge } = require('./common/bridge-factory');
const { freeze } = Object;

// ============================================================================
// Load Libraries
// ============================================================================

// Load highlight.js with core languages
let hljs = null;
try {
  hljs = require('highlight.js/lib/core');
  
  // Register essential languages
  hljs.registerLanguage('python', require('highlight.js/lib/languages/python'));
  hljs.registerLanguage('javascript', require('highlight.js/lib/languages/javascript'));
  hljs.registerLanguage('typescript', require('highlight.js/lib/languages/typescript'));
  hljs.registerLanguage('bash', require('highlight.js/lib/languages/bash'));
  hljs.registerLanguage('json', require('highlight.js/lib/languages/json'));
  hljs.registerLanguage('markdown', require('highlight.js/lib/languages/markdown'));
  
  // Configure
  hljs.configure({ ignoreUnescapedHTML: true });
  
  console.log('[ChatPreload] highlight.js loaded with 6 languages');
} catch (error) {
  console.error('[ChatPreload] Failed to load highlight.js:', error);
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
    
    console.log('[ChatPreload] marked loaded successfully');
} catch (error) {
  console.error('[ChatPreload] Failed to load marked:', error);
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
    
    console.log('[ChatPreload] DOMPurify sanitizer loaded');
  }
} catch (error) {
  console.error('[ChatPreload] Failed to load sanitizer:', error);
}

// Load Storage API for PostgreSQL persistence
let storageAPI = null;
try {
  const { StorageAPI } = require('../infrastructure/api/storage');
  const storageClient = new StorageAPI({
    enableLogging: false
  });
  
  // Create frozen API wrapper for contextBridge compatibility
  storageAPI = freeze({
    // Chat operations
    loadChats: () => storageClient.loadChats(),
    loadChat: (chatId) => storageClient.loadChat(chatId),
    createChat: (title) => storageClient.createChat(title),
    updateChatTitle: (chatId, title) => storageClient.updateChatTitle(chatId, title),
    deleteChat: (chatId) => storageClient.deleteChat(chatId),
    
    // Message operations
    loadMessages: (chatId) => storageClient.loadMessages(chatId),
    saveMessage: (chatId, message) => storageClient.saveMessage(chatId, message),
    
    // Artifact operations
    loadArtifacts: (chatId) => storageClient.loadArtifacts(chatId),
    saveArtifact: (chatId, artifact) => storageClient.saveArtifact(chatId, artifact),
    updateArtifactMessageId: (artifactId, messageId, chatId) => storageClient.updateArtifactMessageId(artifactId, messageId, chatId),
    deleteArtifact: (artifactId) => storageClient.deleteArtifact(artifactId),
    
    // Traceability operations
    getMessageArtifacts: (messageId) => storageClient.getMessageArtifacts(messageId),
    getArtifactSource: (artifactId) => storageClient.getArtifactSource(artifactId),
    getLLMMetadata: (messageId) => storageClient.getLLMMetadata(messageId),
    
    // Health check
    healthCheck: () => storageClient.healthCheck(),
    testConnection: () => storageClient.testConnection(),
    
    // Utility
    getStats: () => storageClient.getStats(),
    resetCircuitBreaker: () => storageClient.resetCircuitBreaker(),
    resetRateLimiter: () => storageClient.resetRateLimiter(),
  });
  
  console.log('[ChatPreload] Storage API loaded');
} catch (error) {
  console.error('[ChatPreload] Failed to load Storage API:', error);
}

// ============================================================================
// Create Secure IPC Bridge
// ============================================================================

const ipcBridge = createBridge({
  ipcRenderer,
  context: 'chatWindow',
  enableRateLimiting: true,
  enableSizeValidation: true,
  enablePayloadValidation: true,
  onError: (error, details) => {
    console.error('[ChatPreload] IPC Error:', error.message, details);
  },
});

// ============================================================================
// Chat Window API
// ============================================================================

const aetherAPI = freeze({
  /**
   * Window identifier
   */
  window: 'chat',
  
  /**
   * Is detached window
   */
  isDetachedWindow: true,
  
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
   * Chat Operations
   */
  chat: freeze({
    /**
     * Send message
     * @param {string} message - Message content
     * @param {Object} metadata - Optional metadata
     */
    send: (message, metadata = {}) => {
      ipcBridge.send('chat:send', { message, ...metadata });
    },
    
    /**
     * Persist assistant message
     * @param {Object} data - Message data
     */
    persist: (data) => {
      ipcBridge.send('chat:assistant-persist', data);
    },
    
    /**
     * Stop current request
     */
    stop: () => {
      ipcBridge.send('chat:stop', {});
    },
    
    /**
     * Mark request complete
     * @param {Object} metadata - Completion metadata
     */
    complete: (metadata = {}) => {
      ipcBridge.send('chat:request-complete', metadata);
    },
    
    /**
     * Scroll to message
     * @param {string} messageId - Message ID
     */
    scrollToMessage: (messageId) => {
      ipcBridge.send('chat:scroll-to-message', { messageId });
    },
    
    /**
     * Listen for assistant stream
     * @param {Function} callback - Callback(chunk, metadata)
     * @returns {Function} Cleanup function
     */
    onAssistantStream: (callback) => {
      return ipcBridge.on('chat:assistant-stream', callback);
    },
    
    /**
     * Listen for persisted stream
     * @param {Function} callback - Callback(data)
     * @returns {Function} Cleanup function
     */
    onAssistantStreamPersist: (callback) => {
      return ipcBridge.on('chat:assistant-stream-persist', callback);
    },
    
    /**
     * Listen for request completion
     * @param {Function} callback - Callback(metadata)
     * @returns {Function} Cleanup function
     */
    onRequestComplete: (callback) => {
      return ipcBridge.on('chat:request-complete', callback);
    },
    
    /**
     * Listen for ensure visible
     * @param {Function} callback - Callback()
     * @returns {Function} Cleanup function
     */
    onEnsureVisible: (callback) => {
      return ipcBridge.on('chat:ensure-visible', callback);
    },
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
      ipcBridge.send('chat:window-control', action);
    },
  }),
  
  /**
   * Artifacts Integration
   */
  artifacts: freeze({
    /**
     * Listen for artifact stream from main window (Stage 1)
     * @param {Function} callback - Callback(data)
     * @returns {Function} Cleanup function
     */
    onStream: (callback) => {
      return ipcBridge.on('artifacts:stream', callback);
    },
    
    /**
     * Send stream ready (Stage 2 routing)
     * @param {Object} data - Artifact data
     */
    streamReady: (data) => {
      ipcBridge.send('artifacts:stream:ready', data);
    },
    
    /**
     * Focus artifacts window
     * @param {string} artifactId - Artifact ID
     * @param {string} tab - Optional tab
     */
    focus: (artifactId, tab) => {
      ipcBridge.send('artifacts:focus-artifacts', { artifactId, tab });
    },
    
    /**
     * Switch tab in artifacts
     * @param {string} tab - Tab name
     */
    switchTab: (tab) => {
      ipcBridge.send('artifacts:switch-tab', tab);
    },
    
    /**
     * Switch chat in artifacts
     * @param {string} chatId - Chat ID
     */
    switchChat: (chatId) => {
      ipcBridge.send('artifacts:switch-chat', chatId);
    },
    
    /**
     * Load code into artifacts
     * @param {string} code - Code content
     * @param {string} language - Language
     * @param {string} filename - Filename
     */
    loadCode: (code, language, filename) => {
      ipcBridge.send('artifacts:load-code', { code, language, filename });
    },
    
    /**
     * Load output into artifacts
     * @param {string} output - Output content
     * @param {string} format - Format (text|html|json|markdown)
     */
    loadOutput: (output, format) => {
      ipcBridge.send('artifacts:load-output', { output, format });
    },
    
    /**
     * Open file
     * @param {string} path - File path
     */
    openFile: (path) => {
      ipcBridge.send('artifacts:open-file', { path });
    },
    
    /**
     * Control artifacts window
     * @param {string} action - minimize|maximize|close|toggle-visibility
     */
    controlWindow: (action) => {
      ipcBridge.send('artifacts:window-control', action);
    },
    
    /**
     * Listen for window state changes
     * @param {Function} callback - Callback(isActive)
     * @returns {Function} Cleanup function
     */
    onWindowState: (callback) => {
      return ipcBridge.on('artifacts:window-state', callback);
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
  
  console.log('[ChatPreload] Chat window API exposed successfully', {
    hljs: !!hljs,
    marked: !!marked,
    sanitizer: !!sanitizer,
    storageAPI: !!storageAPI,
  });
} catch (error) {
  console.error('[ChatPreload] Failed to expose API:', error);
  throw error;
}

