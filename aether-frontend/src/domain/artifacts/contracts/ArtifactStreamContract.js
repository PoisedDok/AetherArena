'use strict';

// Incoming: ChatController._handleArtifactStream() (stream payloads) --- {artifact_types.stream_payload, json}
// Processing: Normalize backend payloads to frontend structure, enforce required identifiers --- {2 jobs: JOB_PARSE, JOB_TRANSFORM}
// Outgoing: normalizeArtifactStreamPayload(), resolvePhaseKindFromPayload(), getArtifactVariantKey() --- {artifact_types.normalized_stream, javascript_object}
//
// ARCHITECTURAL NOTE: Frontend enforces stream invariants (no fallbacks).

const { freeze } = Object;

const DEFAULT_ROLE = 'assistant';
const COMPUTER_ROLE = 'computer';

const ROLE_MAP = freeze({
  assistant: 'assistant',
  computer: 'computer',
  server: COMPUTER_ROLE
});

const TYPE_MAP = freeze({
  code: 'code',
  output: 'output',
  html: 'output',
  console: 'output',
  text: 'output',
  json: 'output',
  markdown: 'output'
});

/**
 * Normalize backend-validated artifact stream payload to frontend structure
 * ARCHITECTURE: Backend already validated - frontend normalizes structure only
 */
function normalizeArtifactStreamPayload(raw = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('CONTRACT VIOLATION: artifact stream payload must be object');
  }

  const metadata = typeof raw.metadata === 'object' && raw.metadata !== null ? { ...raw.metadata } : {};
  const artifact_id = _stringOrNull(raw.artifact_id);
  const isStartMarker = Boolean(raw.start) && !raw.end;
  const isEndMarker = Boolean(raw.end);

  if (!artifact_id && !isStartMarker && !isEndMarker) {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide artifact_id for content chunks. Received keys: ${Object.keys(raw)}`
    );
  }

  const requestId = _stringOrNull(raw.request_id);
  if (!requestId) {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide request_id. artifact_id=${artifact_id || 'none'}`
    );
  }

  if (!raw.role || typeof raw.role !== 'string') {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide role. artifact_id=${artifact_id || 'none'}, requestId=${requestId}`
    );
  }
  const role = _normalizeRole(raw.role);

  if (!raw.type || typeof raw.type !== 'string') {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide type. artifact_id=${artifact_id || 'none'}, requestId=${requestId}`
    );
  }
  const type = _normalizeType(raw.type);

  const chatId = _stringOrNull(raw.chat_id);
  if (!chatId) {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide chat_id. artifact_id=${artifact_id || 'none'}, requestId=${requestId}`
    );
  }

  const format = _stringOrNull(raw.format) || null;
  const language = _stringOrNull(raw.language) || null;
  const messageId = _stringOrNull(raw.message_id) || null;
  const parentId = _stringOrNull(raw.parent_id) || null;
  const correlationId = _stringOrNull(raw.correlation_id) || null;
  const executionGroup = _stringOrNull(raw.execution_group) || null;

  if (!raw.timestamp || (typeof raw.timestamp !== 'string' && typeof raw.timestamp !== 'number')) {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide timestamp. artifact_id=${artifact_id || 'none'}, requestId=${requestId}`
    );
  }
  const timestamp = typeof raw.timestamp === 'string'
    ? (isNaN(Date.parse(raw.timestamp)) ? Date.now() : Date.parse(raw.timestamp))
    : raw.timestamp;

  let content = null;
  if (raw.content !== undefined && raw.content !== null) {
    if (typeof raw.content !== 'string') {
      throw new Error(
        `CONTRACT VIOLATION: Backend content must be string if provided. artifact_id=${artifact_id || 'none'}, requestId=${requestId}`
      );
    }
    content = raw.content;
  }

  metadata.role = role;
  metadata.request_id = requestId;
  metadata.artifact_id = artifact_id;

  const recipient = _stringOrNull(raw.recipient);
  const node_id = _stringOrNull(raw.node_id);
  const subgroup_id = _stringOrNull(raw.subgroup_id);

  const normalized = {
    id: requestId,
    artifact_id,
    artifactId: artifact_id,
    executionGroup,
    role,
    type,
    kind: type,
    format,
    language,
    content,
    chatId,
    messageId,
    parentId,
    correlationId,
    requestId,
    recipient,
    start: Boolean(raw.start),
    end: Boolean(raw.end),
    timestamp,
    metadata
  };

  if (node_id) normalized.node_id = node_id;
  if (subgroup_id) normalized.subgroup_id = subgroup_id;

  return normalized;
}

function resolvePhaseKindFromPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('[resolvePhaseKindFromPayload] CONTRACT VIOLATION: payload must be object');
  }
  if (!payload.role || typeof payload.role !== 'string') {
    throw new Error('[resolvePhaseKindFromPayload] CONTRACT VIOLATION: payload.role is required');
  }
  if (!payload.type || typeof payload.type !== 'string') {
    throw new Error('[resolvePhaseKindFromPayload] CONTRACT VIOLATION: payload.type is required');
  }
  const role = payload.role || DEFAULT_ROLE;
  const type = payload.type || payload.kind;

  if (role === 'assistant' && type === 'code') {
    return 'write';
  }
  if (role === COMPUTER_ROLE && type === 'console') {
    return 'execute';
  }
  if (role === COMPUTER_ROLE && (type === 'code' || type === 'output' || type === 'html')) {
    return 'output';
  }

  return null;
}

function getArtifactVariantKey(role, type) {
  if (!role || typeof role !== 'string') {
    throw new Error('[getArtifactVariantKey] CONTRACT VIOLATION: role is required');
  }
  if (!type || typeof type !== 'string') {
    throw new Error('[getArtifactVariantKey] CONTRACT VIOLATION: type is required');
  }
  const safeRole = role.toLowerCase();
  const safeType = type.toLowerCase();
  return `${safeRole}:${safeType}`;
}

// REMOVED: enforceArtifactSizeLimit  
// ARCHITECTURE: Backend enforces ALL size limits - frontend trusts backend-enforced limits

function _stringOrNull(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function _normalizeRole(role) {
  if (!role || typeof role !== 'string') {
    throw new Error('CONTRACT VIOLATION: role must be a non-empty string');
  }
  const normalized = ROLE_MAP[role.toLowerCase()];
  if (!normalized) {
    throw new Error(`CONTRACT VIOLATION: Invalid role '${role}'. Must be one of: ${Object.keys(ROLE_MAP).join(', ')}`);
  }
  return normalized;
}

function _normalizeType(type) {
  if (!type || typeof type !== 'string') {
    throw new Error('CONTRACT VIOLATION: type must be a non-empty string');
  }
  const normalized = TYPE_MAP[type.toLowerCase()];
  if (!normalized) {
    throw new Error(
      `CONTRACT VIOLATION: Invalid type '${type}'. ` +
      `Must be 'code' or 'output' (format specifies rendering).`
    );
  }
  return normalized;
}

module.exports = {
  normalizeArtifactStreamPayload,
  resolvePhaseKindFromPayload,
  getArtifactVariantKey
};
