'use strict';

/**
 * @.architecture
 *
 * Incoming: Renderer modules requesting deterministic identifiers --- {FunctionCalls, javascript_api}
 * Processing: Proxy to preload session bridge backed by main-process SessionManager --- {3 jobs: JOB_DELEGATE_TO_MODULE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE}
 * Outgoing: Deterministic identifier strings, session stats --- {Promise, json}
 */

const { createRendererLogger } = require('../utils/logger');
const { getAether } = require('../bridge/AetherBridge');

const log = createRendererLogger('SessionBridge').child({ scope: 'adapter' });

function ensureBridge() {
  const bridge = getAether()?.session;
  if (!bridge) {
    const message = '[SessionBridge] Preload session API is unavailable. Ensure session bridge is exposed.';
    log.error(message);
    throw new Error(message);
  }
  return bridge;
}

async function setActiveChat(chatId) {
  if (!chatId || typeof chatId !== 'string') {
    throw new Error('[SessionBridge] chatId must be a non-empty string');
  }
  const bridge = ensureBridge();
  return bridge.setActiveChat(chatId);
}

async function nextUserMessageId({ chatId } = {}) {
  const bridge = ensureBridge();
  const id = await bridge.nextUserMessageId({ chatId });
  return id;
}

async function nextAssistantMessageId({ parentId, chatId } = {}) {
  const bridge = ensureBridge();
  const id = await bridge.nextAssistantMessageId({ parentId, chatId });
  return id;
}

async function nextCodeArtifactId({ parentId, chatId } = {}) {
  const bridge = ensureBridge();
  const id = await bridge.nextCodeArtifactId({ parentId, chatId });
  return id;
}

async function nextOutputArtifactId({ parentId, chatId } = {}) {
  const bridge = ensureBridge();
  const id = await bridge.nextOutputArtifactId({ parentId, chatId });
  return id;
}

async function nextHtmlArtifactId({ parentId, chatId } = {}) {
  const bridge = ensureBridge();
  const id = await bridge.nextHtmlArtifactId({ parentId, chatId });
  return id;
}

async function nextAttachmentId({ parentId, chatId } = {}) {
  const bridge = ensureBridge();
  const id = await bridge.nextAttachmentId({ parentId, chatId });
  return id;
}

async function parseId(id) {
  if (!id || typeof id !== 'string') {
    throw new Error('[SessionBridge] id must be a non-empty string');
  }
  const bridge = ensureBridge();
  return bridge.parseId(id);
}

async function getStats() {
  const bridge = ensureBridge();
  return bridge.getStats();
}

async function clearChatSession(chatId) {
  if (!chatId || typeof chatId !== 'string') {
    throw new Error('[SessionBridge] chatId must be provided to clear session');
  }
  const bridge = ensureBridge();
  return bridge.clearChatSession(chatId);
}

async function clearAll() {
  const bridge = ensureBridge();
  return bridge.clearAll();
}

module.exports = {
  setActiveChat,
  nextUserMessageId,
  nextAssistantMessageId,
  nextCodeArtifactId,
  nextOutputArtifactId,
  nextHtmlArtifactId,
  nextAttachmentId,
  parseId,
  getStats,
  clearChatSession,
  clearAll
};
