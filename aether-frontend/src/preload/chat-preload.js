'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron ipcRenderer (from main process) --- {object, javascript_api}
 * Processing: Load libraries (highlight.js 6 languages, marked, DOMPurify, StorageAPI), create secure IPC bridge with validation, freeze API objects, expose to renderer via contextBridge --- {3 jobs: JOB_CREATE_BRIDGE, JOB_CREATE_WRAPPER, JOB_DELEGATE_TO_MODULE}
 * Outgoing: window.aether (storage bridge + IPC), window.hljs, window.marked, window.sanitizer --- {object, javascript_api}
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
const { createLogger } = require('../core/utils/logger');
const { freeze } = Object;
const rendererConfig = require('../core/config/renderer-config');
const { injectCspMeta } = require('./common/csp-injector');

const log = createLogger({ component: 'ChatPreload' });

// Inject CSP as early as possible for file:// renderers (preload runs before renderer JS).
injectCspMeta({ getConfigSnapshot: rendererConfig.getConfigSnapshot });

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
  
  log.info('highlight.js loaded with 6 languages');
} catch (error) {
  log.error('failed to load highlight.js', { error: error.message });
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
    
    log.info('marked loaded successfully');
} catch (error) {
  log.error('failed to load marked', { error: error.message });
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
            cfg.ALLOWED_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
            break;
          case 'strict':
          default:
            cfg.ALLOWED_TAGS = ['b','i','em','strong','a','p','br','code','pre'];
            cfg.ALLOWED_ATTR = ['href','title','target'];
            cfg.ALLOWED_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
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
    
    log.info('DOMPurify sanitizer loaded');
  }
} catch (error) {
  log.error('failed to load sanitizer', { error: error.message });
}

// ============================================================================
// Create Secure IPC Bridge (MUST be created BEFORE storageAPI uses it)
// ============================================================================

const ipcBridge = createBridge({
  ipcRenderer,
  context: 'chatWindow',
  enableRateLimiting: true,
  enableSizeValidation: true,
  enablePayloadValidation: true,
  onError: (error, details) => {
    log.error('IPC error', { error: error.message, details });
  },
});

// Storage API - Backend proxy via IPC
// NOTE: Direct Supabase client cannot work in preload due to Node.js stream dependencies
// All database operations go through backend API via IPC bridge
let storageAPI = null;
try {
  // Create IPC-based storage API that proxies to backend
  storageAPI = freeze({
    // Chat operations
    loadChats: async () => {
      return new Promise((resolve, reject) => {
        ipcBridge.invoke('storage:load-chats')
          .then(resolve)
          .catch(reject);
      });
    },
    loadChat: async (chatId) => {
      return ipcBridge.invoke('storage:load-chat', { chatId });
    },
    createChat: async (title) => {
      return ipcBridge.invoke('storage:create-chat', { title });
    },
    updateChatTitle: async (chatId, title) => {
      return ipcBridge.invoke('storage:update-chat-title', { chatId, title });
    },
    deleteChat: async (chatId) => {
      return ipcBridge.invoke('storage:delete-chat', { chatId });
    },
    
    // Message operations
    loadMessages: async (chatId) => {
      return ipcBridge.invoke('storage:load-messages', { chatId });
    },
    saveMessage: async (chatId, message) => {
      return ipcBridge.invoke('storage:save-message', { chatId, message });
    },
    
    // Artifact operations
    loadArtifacts: async (chatId) => {
      return ipcBridge.invoke('storage:load-artifacts', { chatId });
    },
    saveArtifact: async (chatId, artifact) => {
      return ipcBridge.invoke('storage:save-artifact', { chatId, artifact });
    },
    updateArtifactMessageId: async (artifactId, messageId, chatId) => {
      return ipcBridge.invoke('storage:update-artifact-message-id', { artifactId, messageId, chatId });
    },
    
    // Trail hierarchy operations (NEW ARCHITECTURE - replaces legacy trail_states)
    // See contracts/README.md (Trail hierarchy + invariants)
    loadTrailHierarchy: async (chatId) => {
      return ipcBridge.invoke('storage:load-trail-hierarchy', { chatId });
    },
    
    // REMOVED: saveTrailState() - trail hierarchy is built in real-time via WebSocket events
    // Backend owns trail persistence via ws/application/trail_service.py
    // Frontend ONLY reconstructs DOM from backend-authoritative hierarchy
    deleteArtifact: async (artifactId) => {
      return ipcBridge.invoke('storage:delete-artifact', { artifactId });
    },
    
    // Traceability operations
    getMessageArtifacts: async (messageId) => {
      return ipcBridge.invoke('storage:get-message-artifacts', { messageId });
    },
    getArtifactSource: async (artifactId) => {
      return ipcBridge.invoke('storage:get-artifact-source', { artifactId });
    },
    getLLMMetadata: async (messageId) => {
      return ipcBridge.invoke('storage:get-llm-metadata', { messageId });
    },
    getArtifact: async (artifactId) => {  // CRITICAL FIX: Alias for getArtifactSource
      return ipcBridge.invoke('storage:get-artifact-source', { artifactId });
    },
    
    // Trail state operations REMOVED - backend persists automatically
    
    // Health check
    healthCheck: async () => {
      return ipcBridge.invoke('storage:health-check');
    },
    testConnection: async () => {
      return ipcBridge.invoke('storage:test-connection');
    },
    
    // Utility
    getStats: async () => {
      return ipcBridge.invoke('storage:get-stats');
    },
    resetCircuitBreaker: () => {
      // No-op for IPC implementation
      return Promise.resolve();
    },
    resetRateLimiter: () => {
      // No-op for IPC implementation
      return Promise.resolve();
    }
  });
  
  log.info('storage API loaded (IPC proxy to backend)');
} catch (error) {
  log.error('failed to load storage API', { error: error.message });
  storageAPI = null;
}

// ============================================================================
// Chat Window API
// ============================================================================

const aetherAPI = freeze({
  /**
   * Window identifier
   */
  window: 'chat',

  /**
   * Renderer-safe configuration snapshot (no hardcoding in renderer)
   */
  config: freeze({
    getSnapshot: () => {
      try {
        return rendererConfig.getConfigSnapshot();
      } catch (error) {
        return null;
      }
    },
  }),
  
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
    invoke: ipcBridge.invoke.bind(ipcBridge),
  }),
  
  /**
   * Chat Operations
   */
  chat: freeze({
    /**
     * Listen for STT stream from main window
     * @param {Function} callback - Callback(data)
     * @returns {Function} Cleanup function
     */
    onSttStream: (callback) => {
      return ipcBridge.on('chat:stt-stream', callback);
    },
    
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
    stop: (requestId = null) => {
      const payload = requestId ? { requestId } : {};
      ipcBridge.send('chat:stop', payload);
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
    
    /**
     * Listen for load specific chat
     * @param {Function} callback - Callback(data)
     * @returns {Function} Cleanup function
     */
    onLoadSpecific: (callback) => {
      return ipcBridge.on('chat:load-specific', callback);
    },
    
    /**
     * Listen for new chat request
     * @param {Function} callback - Callback()
     * @returns {Function} Cleanup function
     */
    onNewRequested: (callback) => {
      return ipcBridge.on('chat:new-requested', callback);
    },
    
    /**
     * Listen for proactive context (from widget proactive notifications)
     * @param {Function} callback - Callback({ initialMessage, context })
     * @returns {Function} Cleanup function
     */
    onProactiveContext: (callback) => {
      return ipcBridge.on('chat:proactive-context', callback);
    },
    
    /**
     * Listen for notch mode changes
     * @param {Function} callback - Callback(data)
     * @returns {Function} Cleanup function
     */
    onNotchModeChanged: (callback) => {
      return ipcBridge.on('chat:notch-mode-changed', callback);
    },

    /**
     * Report mouse hover activity for notch mode
     * @param {boolean} hovering - true if mouse is over window, false otherwise
     */
    reportNotchProximity: (hovering) => {
      ipcBridge.send('chat:notch-proximity', { hovering });
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
    
    /**
     * Report hide animation completed
     */
    hideCompleted: () => {
      ipcBridge.send('chat:hide-completed');
    },

    /**
     * Listen for initiate hide
     * @param {Function} callback - Callback()
     * @returns {Function} Cleanup function
     */
    onInitiateHide: (callback) => {
      return ipcBridge.on('chat:initiate-hide', callback);
    },

    /**
     * Listen for cancel hide
     * @param {Function} callback - Callback()
     * @returns {Function} Cleanup function
     */
    onCancelHide: (callback) => {
      return ipcBridge.on('chat:cancel-hide', callback);
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
  storage: storageAPI,
  storageAPI,

  /**
   * Session API
   */
  session: freeze({
    setActiveChat: (chatId) => ipcBridge.invoke('session:set-active', { chatId }),
    async nextUserMessageId(options = {}) {
      const response = await ipcBridge.invoke('session:next-id', {
        kind: 'user_message',
        chatId: options.chatId
      });
      return response.id;
    },
    async nextAssistantMessageId(options = {}) {
      const response = await ipcBridge.invoke('session:next-id', {
        kind: 'assistant_message',
        parentId: options.parentId,
        chatId: options.chatId
      });
      return response.id;
    },
    async nextCodeArtifactId(options = {}) {
      const response = await ipcBridge.invoke('session:next-id', {
        kind: 'assistant_code',
        parentId: options.parentId,
        chatId: options.chatId
      });
      return response.id;
    },
    async nextOutputArtifactId(options = {}) {
      const response = await ipcBridge.invoke('session:next-id', {
        kind: 'assistant_output',
        parentId: options.parentId,
        chatId: options.chatId
      });
      return response.id;
    },
    async nextHtmlArtifactId(options = {}) {
      const response = await ipcBridge.invoke('session:next-id', {
        kind: 'assistant_html',
        parentId: options.parentId,
        chatId: options.chatId
      });
      return response.id;
    },
    async nextAttachmentId(options = {}) {
      const response = await ipcBridge.invoke('session:next-id', {
        kind: 'user_attachment',
        parentId: options.parentId,
        chatId: options.chatId
      });
      return response.id;
    },
    parseId: (id) => ipcBridge.invoke('session:parse-id', { id }),
    getStats: () => ipcBridge.invoke('session:get-stats'),
    clearChatSession: (chatId) => ipcBridge.invoke('session:clear', { chatId }),
    clearAll: () => ipcBridge.invoke('session:clear-all')
  }),
  
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
   * Memory Management (Phase 9B, ticket #136)
   */
  memories: freeze({
    create: (data) => ipcBridge.invoke('memories:create', { data }),
    list: (filters = {}) => ipcBridge.invoke('memories:list', { filters }),
    get: (memoryId) => ipcBridge.invoke('memories:get', { memoryId }),
    update: (memoryId, updates) => ipcBridge.invoke('memories:update', { memoryId, updates }),
    delete: (memoryId) => ipcBridge.invoke('memories:delete', { memoryId }),
    search: (query, options = {}) => ipcBridge.invoke('memories:search', { query, options }),
    getRelations: (memoryId) => ipcBridge.invoke('memories:get-relations', { memoryId }),
    createRelation: (memoryId, relatedMemoryId, data = {}) =>
      ipcBridge.invoke('memories:create-relation', { memoryId, relatedMemoryId, data }),
    deleteRelation: (relationId) => ipcBridge.invoke('memories:delete-relation', { relationId }),
    promote: (memoryId) => ipcBridge.invoke('memories:promote', { memoryId }),
    demote: (memoryId, chatId) => ipcBridge.invoke('memories:demote', { memoryId, chatId }),
  }),

  /**
   * Chat Summaries Integration (Phase 9D)
   */
  chatSummaries: freeze({
    generate: (chatId, options = {}) =>
      ipcBridge.invoke('storage:generate-chat-summary', { chatId, ...options }),
    list: (chatId) => ipcBridge.invoke('storage:get-chat-summaries', { chatId }),
    search: (query, limit = 10, offset = 0) =>
      ipcBridge.invoke('storage:search-chats', { query, limit, offset }),
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
  log.info('chat window API exposed', { hljs: !!hljs, marked: !!marked, sanitizer: !!sanitizer, storage: !!storageAPI });
} catch (error) {
  log.error('failed to expose API', { error: error.message });
  throw error;
}
