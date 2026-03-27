'use strict';

/**
 * @.architecture
 * 
 * Incoming: bridge-factory (getChannelConfig, canSend, canReceive) --- {method_call, string}
 * Processing: Define frozen channel whitelist per window (mainWindow: send 16 channels, receive 7 channels; chatWindow: send 17 channels, receive 7 channels; artifactsWindow: send 6 channels, receive 9 channels), normalize context names (main → mainWindow, chat → chatWindow, artifacts → artifactsWindow), provide channel validation (canSend, canReceive, validateChannel), frozen registry prevents runtime modification --- {2 jobs: JOB_GET_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Channel config {name, send, receive}, validation results --- {channel_config | boolean, javascript_object_frozen | boolean}
 * 
 * 
 * @module preload/ipc/channels
 * 
 * IPC Channel Registry
 * ============================================================================
 * Defines whitelisted IPC channels for each window context.
 * All channel arrays are frozen to prevent runtime modification.
 * 
 * Security:
 * - Only listed channels can be used for IPC communication
 * - Separate send/receive channels per window
 * - No dynamic channel registration at runtime
 * 
 * @module preload/ipc/channels
 */

const { freeze } = Object;

/**
 * Main Window IPC Channels
 * Primary UI and widget mode window
 */
const mainWindow = freeze({
  name: 'mainWindow',
  
  // Channels this window can SEND to main process
  send: freeze([
    'renderer-log',
    'open-external-url',
    // system
    'system:get-stats',
    'backend:get-url',
    'app:get-log-paths',
    'app:open-log-directory',
    'startup:animation-complete',
    'startup:welcome-complete',
    'model:warmup',
    'app:relaunch',
    'app:quit',
    'toggle-widget-mode',
    'window-double-clicked',
    'window-toggle-chat',
    'widget-drag-start',
    'widget-drag-move',
    'widget-drag-end',
    'wheel-event',
    'zoom-in',
    'zoom-out',
    // chat control
    'chat:window-control',
    'chat:show-window',
    'chat:switch-to-chat',
    'chat:proactive-context',
    'chat:send',
    'chat:stop',
    'chat:request-complete',
    'chat:message:failed',
    'chat:assistant-stream',
    'chat:assistant-persist',
    // artifacts control
    'artifacts:window-control',
    'artifacts:show-window',
    'artifacts:ensure-visible',
    'artifacts:switch-tab',
    'artifacts:load-output',
    'artifacts:stream',
    'artifacts:file-export',
    'artifacts:mode-changed',
    'artifacts:open-file',
    // about (legal notices)
    'about:open-notices-file',
    // session (deterministic ids)
    'session:set-active',
    'session:next-id',
    'session:parse-id',
    'session:get-stats',
    'session:clear',
    'session:clear-all',
    // storage API
    'storage:load-chats',
    'storage:load-chat',
    'storage:create-chat',
    'storage:update-chat-title',
    'storage:delete-chat',
    'storage:load-messages',
    'storage:save-message',
    'storage:load-artifacts',
    'storage:save-artifact',
    'storage:update-artifact-message-id',
    'storage:delete-artifact',
    'storage:get-message-artifacts',
    'storage:get-artifact-source',
    'storage:get-llm-metadata',
    'storage:load-trail-hierarchy',
    'storage:health-check',
    'storage:test-connection',
    'storage:get-stats',
    // memories (Phase 9E)
    'memories:create',
    'memories:list',
    'memories:get',
    'memories:update',
    'memories:delete',
    'memories:search',
    'memories:get-relations',
    'memories:create-relation',
    'memories:delete-relation',
    'memories:promote',
    'memories:demote',
    // window controls
    'window:open-agents',
    // dialog API (file/folder pickers)
    'dialog:show-directory-picker',
    'dialog:show-file-picker',
    'dialog:save-pdf',
    'dialog:save-file',
    'dialog:read-file',
    'file:read-by-path',
    'window:open-notes',
    'window:open-index-browser',
    'window:open-research',
    // Panel dock (query aux window visibility)
    'aux:get-visibility',
    // Widget mode state sync (renderer queries after late initialization)
    'widget-mode:get-state',
  ]),
  
  // Channels this window can RECEIVE from main process
  receive: freeze([
    'enter-widget-mode',
    'exit-widget-mode',
    'demo:toggle',
    'chat:stop',
    'chat:send',
    'chat:assistant-stream',
    'chat:assistant-stream-persist',
    'chat:request-complete',
    'chat:message:failed',
    // Panel dock (aux window visibility state pushed from main process)
    'aux:visibility-changed',
    'window:open-agents',
  ]),
});

/**
 * Chat Window IPC Channels
 * Dedicated chat interface (floating window)
 */
const chatWindow = freeze({
  name: 'chatWindow',
  
  // Channels this window can SEND to main process
  send: freeze([
    'renderer-log',
    // system
    'backend:get-url',
    // session (deterministic ids)
    'session:set-active',
    'session:next-id',
    'session:parse-id',
    'session:get-stats',
    'session:clear',
    'session:clear-all',
    // storage API
    'storage:load-chats',
    'storage:load-chat',
    'storage:create-chat',
    'storage:update-chat-title',
    'storage:delete-chat',
    'storage:load-messages',
    'storage:save-message',
    'storage:load-artifacts',
    'storage:save-artifact',
    'storage:update-artifact-message-id',
    'storage:delete-artifact',
    'storage:get-message-artifacts',
    'storage:get-artifact-source',
    'storage:get-llm-metadata',
    'storage:load-trail-hierarchy',
    'storage:health-check',
    'storage:test-connection',
    'storage:get-stats',
    'chat:window-control',
    'chat:send',
    'chat:assistant-persist',
    'chat:request-complete',
    'chat:message:failed',
    'chat:stop',
    'chat:scroll-to-message',
    'chat:stt-stream',
    'chat:renderer-ready',
    'chat:hide-completed',
    'chat:notch-proximity',
    'chat:switch-to-chat',
    // artifacts coordination
    'artifacts:window-control',
    'artifacts:focus-artifacts',
    'artifacts:switch-tab',
    'artifacts:switch-chat',
    'artifacts:load-code',
    'artifacts:load-output',
    'artifacts:open-file',
    'artifacts:stream:ready',
    'artifacts:ensure-visible',
    'artifacts:show-artifact',
    'artifacts:show-window',
    // chat summaries (Phase 9D)
    'storage:generate-chat-summary',
    'storage:get-chat-summaries',
    'storage:search-chats',
    // memories (Phase 9E)
    'memories:create',
    'memories:list',
    'memories:get',
    'memories:update',
    'memories:delete',
    'memories:search',
    'memories:get-relations',
    'memories:create-relation',
    'memories:delete-relation',
    'memories:promote',
    'memories:demote',
    // window controls
    'window:open-agents',
    'window:open-index-browser',
    'window:open-research',
    // dialog API (PDF export from chat window)
    'dialog:save-pdf',
  ]),
  
  // Channels this window can RECEIVE from main process
  receive: freeze([
    'chat:ensure-visible',
    'chat:new-requested',
    'chat:load-specific',
    'chat:proactive-context',
    'chat:notch-mode-changed',
    'chat:assistant-stream',
    'chat:assistant-stream-persist',
    'chat:request-complete',
    'chat:message:failed',
    'chat:stt-stream',
    'chat:initiate-hide',
    'chat:cancel-hide',
    'artifacts:window-state',
    'artifacts:stream',
  ]),
});

/**
 * Artifacts Window IPC Channels
 * Code execution and output display window
 */
const artifactsWindow = freeze({
  name: 'artifactsWindow',
  
  // Channels this window can SEND to main process
  send: freeze([
    'renderer-log',
    // system
    'backend:get-url',
    // session (deterministic ids)
    'session:set-active',
    'session:next-id',
    'session:parse-id',
    'session:get-stats',
    'session:clear',
    'session:clear-all',
    // storage API
    'storage:load-chats',
    'storage:load-chat',
    'storage:create-chat',
    'storage:update-chat-title',
    'storage:delete-chat',
    'storage:load-messages',
    'storage:save-message',
    'storage:load-artifacts',
    'storage:save-artifact',
    'storage:update-artifact-message-id',
    'storage:delete-artifact',
    'storage:get-message-artifacts',
    'storage:get-artifact-source',
    'storage:get-llm-metadata',
    'storage:load-trail-hierarchy',
    'storage:health-check',
    'storage:test-connection',
    'storage:get-stats',
    'artifacts:mode-changed',
    'artifacts:window-state',
    'artifacts:window-control',
    'artifacts:hide-completed',
    'artifacts:file-export',
    'artifacts:open-file',
    'artifacts:renderer-ready',
    // Execute code via backend (routed through main process to main window chat sender)
    'artifacts:execute-code',
    'window:open-research',
    // dialog API (PDF export from artifacts window)
    'dialog:save-pdf',
  ]),
  
  // Channels this window can RECEIVE from main process
  receive: freeze([
    'artifacts:ensure-visible',
    'artifacts:set-mode',
    'artifacts:stream',
    'artifacts:focus-artifacts',
    'artifacts:switch-tab',
    'artifacts:switch-chat',
    'artifacts:load-code',
    'artifacts:load-output',
    'artifacts:show-artifact',
    'artifacts:initiate-hide',
    'artifacts:cancel-hide',
  ]),
});

/**
 * Notes Window IPC Channels
 * Detached study notes window
 */
const notesWindow = freeze({
  name: 'notesWindow',
  
  // Channels this window can SEND to main process
  send: freeze([
    'renderer-log',
    'open-external-url',
    // dialog API
    'dialog:save-file',
    'dialog:read-file',
    'notes:window-control',
  ]),
  
  // Channels this window can RECEIVE from main process
  receive: freeze([
    'notes:init'
  ]),
});

/**
 * Index Browser Window IPC Channels
 * Detached index browser window
 */
const indexBrowserWindow = freeze({
  name: 'indexBrowserWindow',
  
  // Channels this window can SEND to main process
  send: freeze([
    'renderer-log',
    'open-external-url',
    'dialog:show-directory-picker',
    'dialog:show-file-picker',
    'file:read-by-path',
    'artifacts:open-file',
    'index-browser:window-control',
    'backend:get-url',
    'window:open-research',
  ]),
  
  // Channels this window can RECEIVE from main process
  receive: freeze([
    'index-browser:init'
  ]),
});

/**
 * Research Window IPC Channels
 * Detached perplexica research window
 */
const researchWindow = freeze({
  name: 'researchWindow',
  
  // Channels this window can SEND to main process
  send: freeze([
    'renderer-log',
    'open-external-url',
    'research:window-control',
    'backend:get-url',
  ]),
  
  // Channels this window can RECEIVE from main process
  receive: freeze([
  ]),
});

/**
 * Channel Registry
 * Maps window names to their channel configurations
 */
const registry = freeze({
  mainWindow,
  chatWindow,
  artifactsWindow,
  notesWindow,
  indexBrowserWindow,
  researchWindow,
});

/**
 * Normalize context name to standard window key
 * @param {string} context - Context name (flexible input)
 * @returns {string} Normalized window key
 */
function normalizeContext(context) {
  if (!context) return 'mainWindow';
  
  const key = String(context).toLowerCase();
  
  // Main window aliases
  if (key === 'main' || key === 'mainwindow' || key === 'main-window') {
    return 'mainWindow';
  }
  
  // Chat window aliases
  if (key === 'chat' || key === 'chatwindow' || key === 'chat-window') {
    return 'chatWindow';
  }
  
  // Artifacts window aliases
  if (key === 'artifacts' || key === 'artifactswindow' || key === 'artifacts-window') {
    return 'artifactsWindow';
  }

  // Notes window aliases
  if (key === 'notes' || key === 'noteswindow' || key === 'notes-window') {
    return 'notesWindow';
  }

  // Index browser window aliases
  if (key === 'indexbrowser' || key === 'indexbrowserwindow' || key === 'index-browser' || key === 'index-browser-window') {
    return 'indexBrowserWindow';
  }
  
  // Direct registry match
  if (registry[context]) {
    return context;
  }
  
  // Default fallback
  return 'mainWindow';
}

/**
 * Get channel configuration for a window context
 * @param {string} context - Window context name
 * @returns {Object} Channel configuration
 * @throws {Error} If context is unknown
 */
function getChannelConfig(context = 'mainWindow') {
  const normalized = normalizeContext(context);
  const config = registry[normalized];
  
  if (!config) {
    throw new Error(`[IPC Channels] Unknown context: ${context}`);
  }
  
  return config;
}

/**
 * Check if channel is allowed for sending in context
 * @param {string} channel - Channel name
 * @param {string} context - Window context
 * @returns {boolean}
 */
function canSend(channel, context = 'mainWindow') {
  try {
    const config = getChannelConfig(context);
    return config.send.includes(channel);
  } catch {
    return false;
  }
}

/**
 * Check if channel is allowed for receiving in context
 * @param {string} channel - Channel name
 * @param {string} context - Window context
 * @returns {boolean}
 */
function canReceive(channel, context = 'mainWindow') {
  try {
    const config = getChannelConfig(context);
    return config.receive.includes(channel);
  } catch {
    return false;
  }
}

/**
 * Get all channels for a window
 * @param {string} context - Window context
 * @returns {Object} { send: Array, receive: Array }
 */
function getAllChannels(context = 'mainWindow') {
  const config = getChannelConfig(context);
  return {
    send: Array.from(config.send),
    receive: Array.from(config.receive),
  };
}

/**
 * Validate channel usage
 * @param {string} channel - Channel name
 * @param {string} direction - 'send' or 'receive'
 * @param {string} context - Window context
 * @throws {Error} If channel is not allowed
 */
function validateChannel(channel, direction, context = 'mainWindow') {
  const config = getChannelConfig(context);
  const allowed = config[direction];
  
  if (!Array.isArray(allowed) || !allowed.includes(channel)) {
    throw new Error(
      `[IPC Security] Channel "${channel}" not allowed for ${direction} in ${context}`
    );
  }
}

module.exports = {
  mainWindow,
  chatWindow,
  artifactsWindow,
  notesWindow,
  indexBrowserWindow,
  researchWindow,
  registry,
  normalizeContext,
  getChannelConfig,
  canSend,
  canReceive,
  getAllChannels,
  validateChannel,
};
