'use strict';

/**
 * @.architecture
 * 
 * Incoming: bridge-factory (getChannelConfig, canSend, canReceive) --- {method_call, string}
 * Processing: Define frozen channel whitelist per window (mainWindow: send 16 channels, receive 7 channels; chatWindow: send 13 channels, receive 6 channels; artifactsWindow: send 6 channels, receive 9 channels), normalize context names (main → mainWindow, chat → chatWindow, artifacts → artifactsWindow), provide channel validation (canSend, canReceive, validateChannel), frozen registry prevents runtime modification --- {4 jobs: JOB_GET_STATE, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA}
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
    'toggle-widget-mode',
    'window-double-clicked',
    'widget-position-update',
    'wheel-event',
    'zoom-in',
    'zoom-out',
    'chat:window-control',
    'chat:send',
    'chat:stop',
    'chat:request-complete',
    'chat:assistant-stream',
    'chat:assistant-persist',
    'artifacts:window-control',
    'artifacts:stream',
    'artifacts:file-export',
    'artifacts:mode-changed',
    'artifacts:open-file',
  ]),
  
  // Channels this window can RECEIVE from main process
  receive: freeze([
    'enter-widget-mode',
    'exit-widget-mode',
    'chat:stop',
    'chat:send',
    'chat:assistant-stream',
    'chat:assistant-stream-persist',
    'chat:request-complete',
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
    'chat:window-control',
    'chat:send',
    'chat:assistant-persist',
    'chat:request-complete',
    'chat:stop',
    'chat:scroll-to-message',
    'artifacts:window-control',
    'artifacts:focus-artifacts',
    'artifacts:switch-tab',
    'artifacts:switch-chat',
    'artifacts:load-code',
    'artifacts:load-output',
    'artifacts:open-file',
    'artifacts:stream:ready',
  ]),
  
  // Channels this window can RECEIVE from main process
  receive: freeze([
    'chat:ensure-visible',
    'chat:assistant-stream',
    'chat:assistant-stream-persist',
    'chat:request-complete',
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
    'artifacts:mode-changed',
    'artifacts:window-state',
    'artifacts:window-control',
    'artifacts:file-export',
    'artifacts:open-file',
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
  registry,
  normalizeContext,
  getChannelConfig,
  canSend,
  canReceive,
  getAllChannels,
  validateChannel,
};

