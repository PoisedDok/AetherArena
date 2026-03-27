'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron ipcRenderer (from main process) --- {object, javascript_api}
 * Processing: Create secure IPC bridge with validation/rate limiting, freeze API objects, expose to renderer via contextBridge --- {3 jobs: JOB_CREATE_BRIDGE, JOB_CREATE_WRAPPER, JOB_DELEGATE_TO_MODULE}
 * Outgoing: window.aether (exposed to renderer) --- {object, javascript_api}
 * 
 * @module preload/main-preload
 * 
 * Main Window Preload Script
 * ============================================================================
 * Secure preload for main widget window.
 * Exposes validated IPC bridge with rate limiting and size checks.
 * 
 * Security:
 * - contextIsolation enabled
 * - Channel whitelisting
 * - Payload validation
 * - Rate limiting
 * - Size validation
 */

const { contextBridge, ipcRenderer } = require('electron');
const { createBridge } = require('./common/bridge-factory');
const { createLogger } = require('../core/utils/logger');
const { freeze } = Object;
const rendererConfig = require('../core/config/renderer-config');
const { injectCspMeta } = require('./common/csp-injector');

const log = createLogger({ component: 'MainPreload' });

// Inject CSP as early as possible for file:// renderers (preload runs before renderer JS).
injectCspMeta({ getConfigSnapshot: rendererConfig.getConfigSnapshot });

// ============================================================================
// Create Secure IPC Bridge
// ============================================================================

const ipcBridge = createBridge({
  ipcRenderer,
  context: 'mainWindow',
  enableRateLimiting: true,
  enableSizeValidation: true,
  enablePayloadValidation: true,
  onError: (error, details) => {
    log.error('IPC error', { error: error.message, details });
  },
});

// ============================================================================
// Main Window API
// ============================================================================

function invokeSession(channel, payload = {}) {
  return ipcBridge.invoke(channel, payload);
}

const sessionAPI = freeze({
  /**
   * Set the active chat session for deterministic id generation
   * @param {string} chatId
   * @returns {Promise<Object>}
   */
  async setActiveChat(chatId) {
    return invokeSession('session:set-active', { chatId });
  },

  /**
   * Generate a user message id (UM)
   * @param {Object} [options]
   * @param {string} [options.chatId]
   * @returns {Promise<string>}
   */
  async nextUserMessageId(options = {}) {
    const response = await invokeSession('session:next-id', {
      kind: 'user_message',
      chatId: options.chatId
    });
    return response.id;
  },

  /**
   * Generate an assistant message id (AM)
   * @param {Object} [options]
   * @param {string} [options.parentId] - user message id
   * @param {string} [options.chatId]
   * @returns {Promise<string>}
   */
  async nextAssistantMessageId(options = {}) {
    const response = await invokeSession('session:next-id', {
      kind: 'assistant_message',
      parentId: options.parentId,
      chatId: options.chatId
    });
    return response.id;
  },

  /**
   * Generate assistant code artifact id (AC)
   */
  async nextCodeArtifactId(options = {}) {
    const response = await invokeSession('session:next-id', {
      kind: 'assistant_code',
      parentId: options.parentId,
      chatId: options.chatId
    });
    return response.id;
  },

  /**
   * Generate assistant output artifact id (AO)
   */
  async nextOutputArtifactId(options = {}) {
    const response = await invokeSession('session:next-id', {
      kind: 'assistant_output',
      parentId: options.parentId,
      chatId: options.chatId
    });
    return response.id;
  },

  /**
   * Generate assistant html artifact id (AH)
   */
  async nextHtmlArtifactId(options = {}) {
    const response = await invokeSession('session:next-id', {
      kind: 'assistant_html',
      parentId: options.parentId,
      chatId: options.chatId
    });
    return response.id;
  },

  /**
   * Generate user attachment id (UA)
   */
  async nextAttachmentId(options = {}) {
    const response = await invokeSession('session:next-id', {
      kind: 'user_attachment',
      parentId: options.parentId,
      chatId: options.chatId
    });
    return response.id;
  },

  /**
   * Parse a deterministic session id
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  parseId(id) {
    return invokeSession('session:parse-id', { id });
  },

  /**
   * Get session manager statistics
   * @returns {Promise<Object>}
   */
  getStats() {
    return invokeSession('session:get-stats');
  },

  /**
   * Clear a specific chat session
   * @param {string} chatId
   * @returns {Promise<Object>}
   */
  clearChatSession(chatId) {
    return invokeSession('session:clear', { chatId });
  },

  /**
   * Clear all sessions
   * @returns {Promise<Object>}
   */
  clearAll() {
    return invokeSession('session:clear-all');
  }
});

const aetherAPI = freeze({
  /**
   * Renderer-safe configuration snapshot (no hardcoding in renderer, no require() in renderer)
   */
  config: freeze({
    getSnapshot: () => {
      try {
        return rendererConfig.getConfigSnapshot();
      } catch (error) {
        // Do not crash preloads/renderers during boot if backend URL isn't resolved yet.
        return null;
      }
    },
  }),

  /**
   * IPC Communication
   */
  ipc: freeze({
    send: ipcBridge.send.bind(ipcBridge),
    on: ipcBridge.on.bind(ipcBridge),
    once: ipcBridge.once.bind(ipcBridge),
    removeListener: ipcBridge.removeListener.bind(ipcBridge),
    removeAllListeners: ipcBridge.removeAllListeners.bind(ipcBridge),
    invoke: ipcBridge.invoke.bind(ipcBridge), // ADD: invoke for async IPC calls
  }),

  /**
   * Window Controls
   */
  window: freeze({
    /**
     * Toggle widget mode
     */
    toggleWidgetMode: () => {
      ipcBridge.send('toggle-widget-mode', {});
    },

    /**
     * Handle double click (toggle widget mode)
     */
    onDoubleClick: () => {
      ipcBridge.send('window-double-clicked', {});
    },

    /**
     * Toggle chat window (create / show / hide)
     */
    toggleChat: () => {
      ipcBridge.send('window-toggle-chat', {});
    },

    /**
     * Open standalone notes window
     * @param {Object} initialData - Optional initial data
     */
    openNotes: (initialData = null) => {
      ipcBridge.send('window:open-notes', initialData);
    },

    /**
     * Begin JS-based widget drag.
     * @param {number} screenX - Cursor screen X at drag start
     * @param {number} screenY - Cursor screen Y at drag start
     */
    dragStart: (screenX, screenY) => {
      ipcBridge.send('widget-drag-start', { screenX, screenY });
    },

    /**
     * Move during JS-based widget drag.
     * @param {number} screenX - Current cursor screen X
     * @param {number} screenY - Current cursor screen Y
     */
    dragMove: (screenX, screenY) => {
      ipcBridge.send('widget-drag-move', { screenX, screenY });
    },

    /**
     * End JS-based widget drag.
     */
    dragEnd: () => {
      ipcBridge.send('widget-drag-end', {});
    },

    /**
     * Zoom in
     */
    zoomIn: () => {
      ipcBridge.send('zoom-in', {});
    },

    /**
     * Zoom out
     */
    zoomOut: () => {
      ipcBridge.send('zoom-out', {});
    },

    /**
     * Handle mouse wheel event
     * @param {number} deltaY - Wheel delta Y
     * @param {boolean} ctrlKey - Is Ctrl key pressed
     */
    onWheel: (deltaY, ctrlKey = false) => {
      ipcBridge.send('wheel-event', { deltaY, ctrlKey });
    },

    /**
     * Listen for widget mode changes
     * @param {Function} callback - Callback(isWidgetMode)
     * @returns {Function} Cleanup function
     */
    onWidgetModeChange: (callback) => {
      const enterCleanup = ipcBridge.on('enter-widget-mode', () => callback(true));
      const exitCleanup = ipcBridge.on('exit-widget-mode', () => callback(false));
      return () => {
        enterCleanup();
        exitCleanup();
      };
    },

    /**
     * Query current widget mode state from main process.
     * Used to sync renderer state after late initialization (e.g., the window
     * entered widget mode during the startup splash before listeners were registered).
     * @returns {Promise<boolean>} Current isWidgetMode state
     */
    getWidgetMode: async () => {
      try {
        const result = await ipcBridge.invoke('widget-mode:get-state', {});
        return result?.isWidgetMode || false;
      } catch (err) {
        // Non-fatal: default to false (normal mode)
        return false;
      }
    },
  }),

  /**
   * Chat Integration
   */
  chat: freeze({
    /**
     * Send message to chat
     * @param {string} message - Message content
     * @param {Object} metadata - Optional metadata
     */
    send: (message, metadata = {}) => {
      ipcBridge.send('chat:send', { message, ...metadata });
    },

    /**
     * Stream user input (STT) to chat
     * @param {Object} data - { text, isFinal, source }
     */
    streamUserInput: (data) => {
      ipcBridge.send('chat:stt-stream', data);
    },

    /**
     * Send message directly to chat (from STT)
     * @param {Object} data - { text, source }
     */
    sendMessage: (data) => {
      ipcBridge.send('chat:send', { message: data.text, metadata: { source: data.source } });
    },

    /**
     * Listen for assistant responses
     * @param {Function} callback - Callback(chunk, metadata)
     * @returns {Function} Cleanup function
     */
    onAssistantStream: (callback) => {
      return ipcBridge.on('chat:assistant-stream', callback);
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
     * Stop current request
     */
    stop: (requestId = null) => {
      const payload = requestId ? { requestId } : {};
      ipcBridge.send('chat:stop', payload);
    },

    /**
     * Open/show chat window
     */
    open: () => {
      ipcBridge.send('chat:window-control', 'toggle-visibility');
    },

    /**
     * Control chat window
     * @param {string} action - minimize|maximize|close|toggle-visibility
     */
    controlWindow: (action) => {
      ipcBridge.send('chat:window-control', action);
    },
  }),

  /**
   * Memory Management (Phase 9B, ticket #136)
   */
  memories: freeze({
    /**
     * Create memory
     * @param {Object} data - {content, memory_type, importance_score, metadata, tags, expires_at}
     * @returns {Promise<Object>}
     */
    create: (data) => ipcBridge.invoke('memories:create', { data }),

    /**
     * List memories with filters
     * @param {Object} filters - {memory_type, min_importance, max_importance, limit, offset}
     * @returns {Promise<Array>}
     */
    list: (filters = {}) => ipcBridge.invoke('memories:list', { filters }),

    /**
     * Get memory by ID
     * @param {string} memoryId - Memory UUID
     * @returns {Promise<Object>}
     */
    get: (memoryId) => ipcBridge.invoke('memories:get', { memoryId }),

    /**
     * Update memory
     * @param {string} memoryId - Memory UUID
     * @param {Object} updates - Fields to update
     * @returns {Promise<Object>}
     */
    update: (memoryId, updates) => ipcBridge.invoke('memories:update', { memoryId, updates }),

    /**
     * Delete memory
     * @param {string} memoryId - Memory UUID
     * @returns {Promise<void>}
     */
    delete: (memoryId) => ipcBridge.invoke('memories:delete', { memoryId }),

    /**
     * Search memories (vector + hybrid)
     * @param {string} query - Search query
     * @param {Object} options - {searchType, limit, threshold}
     * @returns {Promise<Object>}
     */
    search: (query, options = {}) => ipcBridge.invoke('memories:search', { query, options }),

    /**
     * Get memory relations
     * @param {string} memoryId - Memory UUID
     * @returns {Promise<Array>}
     */
    getRelations: (memoryId) => ipcBridge.invoke('memories:get-relations', { memoryId }),

    /**
     * Create memory relation
     * @param {string} memoryId - Source memory UUID
     * @param {string} relatedMemoryId - Target memory UUID
     * @param {Object} data - {relationType, strength}
     * @returns {Promise<Object>}
     */
    createRelation: (memoryId, relatedMemoryId, data = {}) =>
      ipcBridge.invoke('memories:create-relation', { memoryId, relatedMemoryId, data }),

    /**
     * Delete memory relation
     * @param {string} relationId - Relation UUID
     * @returns {Promise<void>}
     */
    deleteRelation: (relationId) => ipcBridge.invoke('memories:delete-relation', { relationId }),

    /**
     * Promote chat-specific memory to global scope
     * @param {string} memoryId - Memory UUID
     * @returns {Promise<Object>}
     */
    promote: (memoryId) => ipcBridge.invoke('memories:promote', { memoryId }),

    /**
     * Demote global memory to chat-specific scope
     * @param {string} memoryId - Memory UUID
     * @param {string} chatId - Target chat UUID
     * @returns {Promise<Object>}
     */
    demote: (memoryId, chatId) => ipcBridge.invoke('memories:demote', { memoryId, chatId }),
  }),

  /**
   * Chat Summaries (Phase 9B, ticket #137)
   */
  chatSummaries: freeze({
    /**
     * Generate chat summary
     * @param {string} chatId - Chat UUID
     * @param {string} summaryType - 'full' | 'brief' | 'technical'
     * @returns {Promise<Object>}
     */
    generate: (chatId, summaryType = 'full') =>
      ipcBridge.invoke('storage:summarize-chat', { chatId, summaryType }),

    /**
     * Get chat summaries
     * @param {string} chatId - Chat UUID
     * @returns {Promise<Array>}
     */
    get: (chatId) =>
      ipcBridge.invoke('storage:get-chat-summaries', { chatId }),

    /**
     * Search chats
     * @param {string} query - Search query
     * @param {Object} options - {limit, searchType, minScore}
     * @returns {Promise<Object>}
     */
    search: (query, options = {}) =>
      ipcBridge.invoke('storage:search-chats', { query, options }),
  }),

  /**
   * Artifacts Integration
   */
  artifacts: freeze({
    /**
     * Stream artifact data
     * @param {Object} data - Artifact data
     */
    stream: (data) => {
      ipcBridge.send('artifacts:stream', data);
    },

    /**
     * Open/show artifacts window
     */
    open: () => {
      ipcBridge.send('artifacts:window-control', 'toggle-visibility');
    },

    /**
     * Control artifacts window
     * @param {string} action - minimize|maximize|close|toggle-visibility
     */
    controlWindow: (action) => {
      ipcBridge.send('artifacts:window-control', action);
    },

    /**
     * Export artifact as file
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
  }),

  /**
   * About — application metadata and legal notices
   */
  about: freeze({
    /**
     * Open the THIRD-PARTY-NOTICES file with the system's default text viewer.
     * Path resolution delegated to main process via IPC (preload sandbox
     * cannot import Node built-ins like 'path').
     */
    openNoticesFile: () => {
      ipcBridge.send('about:open-notices-file', {});
    },
  }),

  /**
   * Panel Dock — aux window visibility state
   * Enables the main renderer to track whether chat/artifacts windows are visible.
   */
  panels: freeze({
    /**
     * Listen for aux window visibility changes (pushed from main process).
     * @param {Function} callback - ({ window: 'chat'|'artifacts', visible: boolean }) => void
     * @returns {Function} Cleanup function
     */
    onVisibilityChange: (callback) => {
      return ipcBridge.on('aux:visibility-changed', callback);
    },

    /**
     * Query current visibility of both aux windows (one-shot).
     * @returns {Promise<{ chat: boolean, artifacts: boolean }>}
     */
    getVisibility: () => {
      return ipcBridge.invoke('aux:get-visibility', {});
    },
  }),

  /**
   * Logging
   */
  log: freeze({
    /**
     * Send log to main process
     * @param {string} message - Log message
     */
    send: (message) => {
      if (typeof message === 'string' && message.length <= 10000) {
        ipcBridge.send('renderer-log', message);
      }
    },
  }),

  /**
   * System Monitor
   */
  system: freeze({
    /**
     * Get system stats (CPU, memory, etc.)
     * @returns {Promise<Object>} System stats
     */
    getStats: () => {
      return ipcBridge.invoke('system:get-stats');
    },
    /**
     * Get application log file paths (for diagnostics display).
     * @returns {Promise<{logsDirectory: string, frontendLog: string, backendSpawnLog: string, userData: string}>}
     */
    getLogPaths: () => {
      return ipcBridge.invoke('app:get-log-paths');
    },
    /**
     * Open the logs directory in the system file manager.
     * @returns {Promise<{success: boolean, path: string}>}
     */
    openLogDirectory: () => {
      return ipcBridge.invoke('app:open-log-directory');
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
   * Session identifier API
   */
  session: sessionAPI,

  /**
   * Get bridge metadata
   * @returns {Object}
   */
  getMetadata: () => ipcBridge.getMetadata(),

  /**
   * Get bridge statistics
   * @returns {Object}
   */
  getStats: () => ipcBridge.getStats(),

  /**
   * File operations directly from disk
   */
  file: freeze({
    /**
     * Read file content
     * @param {string} path - File path
     * @returns {Promise<Object>} { success, content, filename, isBinary, error }
     */
    read: (path) => ipcBridge.invoke('file:read-by-path', { path })
  }),

  /**
   * Dialog API (Native File/Folder Pickers)
   */
  dialog: freeze({
    /**
     * Show directory picker dialog
     * @returns {Promise<string|null>} Selected directory path or null if canceled
     */
    async showDirectoryPicker() {
      try {
        return await ipcBridge.invoke('dialog:show-directory-picker', {});
      } catch (error) {
        log.error('directory picker failed', { error: error.message });
        return null;
      }
    },

    /**
     * Show file picker dialog
     * @param {Object} options - File picker options
     * @param {Array<Object>} options.filters - File type filters
     * @param {boolean} options.multiSelections - Allow multiple selections
     * @returns {Promise<Array<string>|null>} Selected file paths or null if canceled
     */
    async showFilePicker(options = {}) {
      try {
        return await ipcBridge.invoke('dialog:show-file-picker', options);
      } catch (error) {
        log.error('file picker failed', { error: error.message });
        return null;
      }
    },

    /**
     * Save a text file
     * @param {string} content - File content
     * @param {string} defaultPath - Default filename/path
     * @returns {Promise<Object>} { success, filePath, error }
     */
    async saveTextFile(content, defaultPath = 'notes.md') {
      try {
        return await ipcBridge.invoke('dialog:save-file', { content, defaultPath });
      } catch (error) {
        log.error('save file failed', { error: error.message });
        return { success: false, error: error.message };
      }
    },

    /**
     * Read a text file
     * @returns {Promise<Object|null>} { content, filePath, filename }
     */
    async readTextFile() {
      try {
        return await ipcBridge.invoke('dialog:read-file', {});
      } catch (error) {
        log.error('read file failed', { error: error.message });
        return null;
      }
    }
  }),
});

// ============================================================================
// Expose API to Renderer
// ============================================================================

try {
  contextBridge.exposeInMainWorld('aether', aetherAPI);
  log.info('main window API exposed');
} catch (error) {
  log.error('failed to expose API', { error: error.message });
  throw error;
}
