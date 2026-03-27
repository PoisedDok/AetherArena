'use strict';

/**
Incoming: application/main/ArtifactsStreamOrchestrator.js::_createNormalizedPayload --- {websocket.stream_chunk, json}
Processing: Normalize artifact stream payloads, enforce identifiers and size limits --- {3 jobs: JOB_FILTER_DATA, JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA}
Outgoing: renderer/shared/services/artifacts/ArtifactStreamService.js::handleStream --- {ipc.chat_stream_event, json}
*/

const { freeze } = Object;

const DEFAULT_ROLE = 'assistant';
const COMPUTER_ROLE = 'computer';
const MAX_ARTIFACT_SIZE = 50 * 1024 * 1024; // 50MB

const ROLE_MAP = freeze({
  assistant: 'assistant',
  computer: 'computer',
  server: COMPUTER_ROLE
});

// ARCHITECTURAL CONTRACT: Only 2 types exist
// - code: Assistant writes (format specifies language: python, html, js, etc)
// - output: Computer produces (format specifies rendering: console, html, json, text)
const TYPE_MAP = freeze({
  code: 'code',
  output: 'output',
  // Legacy types from OI → normalize to output
  html: 'output',
  console: 'output',
  text: 'output',
  json: 'output',
  markdown: 'output'
});

const ARTIFACT_STREAM_SCHEMA = freeze({
  required: ['artifact_id', 'backend_id', 'role', 'type', 'chat_id'],  // Backend sends snake_case
  enums: {
    role: ['assistant', 'computer'],
    type: ['code', 'output']  // ONLY 2 types - format field specifies details
  }
});

function normalizeArtifactStreamPayload(raw = {}) {  
  if (!raw || typeof raw !== 'object') {
    throw new Error('CONTRACT VIOLATION: artifact stream payload must be object');
  }

  // CONTRACT: artifact_id is optional for start/end markers (arrives after trail linkage)
  const artifact_id = _stringOrNull(raw.artifact_id);
  const isStartMarker = Boolean(raw.start) && !raw.end;
  const isEndMarker = Boolean(raw.end);
  
  if (!artifact_id && !isStartMarker && !isEndMarker) {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide artifact_id for content chunks. Received: ${JSON.stringify(Object.keys(raw))}`
    );
  }

  // CONTRACT: Backend MUST provide request_id (snake_case - canonical identifier)
  const metadata = typeof raw.metadata === 'object' && raw.metadata !== null ? { ...raw.metadata } : {};
  const requestId = _stringOrNull(raw.request_id);
  if (!requestId) {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide request_id. artifact_id=${artifact_id || 'none'}`
    );
  }

  // CONTRACT: Backend MUST provide role
  if (!raw.role || typeof raw.role !== 'string') {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide role. artifact_id=${artifact_id || 'none'}, requestId=${requestId}`
    );
  }
  const role = _normalizeRole(raw.role);

  // CONTRACT: Backend MUST provide type
  if (!raw.type || typeof raw.type !== 'string') {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide type. artifact_id=${artifact_id || 'none'}, requestId=${requestId}`
    );
  }
  const type = _normalizeType(raw.type);

  // CONTRACT: Backend MUST provide chat_id (snake_case - backend sends snake_case)
  const chatId = _stringOrNull(raw.chat_id);
  if (!chatId) {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide chat_id. artifact_id=${artifact_id || 'none'}, requestId=${requestId}`
    );
  }

  // Optional fields - require explicit values or null (no fallbacks)
  const format = _stringOrNull(raw.format) || null;
  const language = _stringOrNull(raw.language) || null;
  
  // CONTRACT: Backend MUST provide message_id (snake_case)
  const messageId = _stringOrNull(raw.message_id) || null;
  
  const parentId = _stringOrNull(raw.parent_id) || null;
  const correlationId = _stringOrNull(raw.correlation_id) || null;
  // requestId already declared above as required field (line 65)
  const executionGroup = _stringOrNull(raw.execution_group) || null;
  
  // CONTRACT: Backend MUST provide timestamp (ISO string - backend sends ISO string)
  if (!raw.timestamp || (typeof raw.timestamp !== 'string' && typeof raw.timestamp !== 'number')) {
    throw new Error(
      `CONTRACT VIOLATION: Backend must provide timestamp. artifact_id=${artifact_id || 'none'}, requestId=${requestId}`
    );
  }
  // Convert ISO string to number if needed, or use as-is
  const timestamp = typeof raw.timestamp === 'string' 
    ? (isNaN(Date.parse(raw.timestamp)) ? Date.now() : Date.parse(raw.timestamp))
    : raw.timestamp;
  
  // CONTRACT: Content is optional (start/end markers may not have content)
  // Allow empty string or null, but if present must be string
  let content = null;
  if (raw.content !== undefined && raw.content !== null) {
    if (typeof raw.content !== 'string') {
      throw new Error(
        `CONTRACT VIOLATION: Backend content must be string if provided. artifact_id=${artifact_id || 'none'}, requestId=${requestId}, content_type=${typeof raw.content}`
      );
    }
    content = raw.content;
  }

  metadata.role = role;
  metadata.request_id = requestId; // Canonical identifier
  metadata.artifact_id = artifact_id;

  const enforced = enforceArtifactSizeLimit(content);
  if (enforced.truncated) {
    metadata.truncated = true;
  }
  content = enforced.content;

  // CRITICAL: Preserve recipient field for filtering assistant-only feedback
  // Backend sends recipient:"assistant" for internal feedback (e.g. "✅ HTML rendered successfully")
  // Frontend must filter these out BEFORE any processing/display/persistence
  // NO DEFAULT VALUE - if backend doesn't send recipient, treat as user-facing
  const recipient = _stringOrNull(raw.recipient);
  
  // ARCHITECTURAL FIX: Preserve trail linkage fields if present
  // MessageManager enriches artifacts with node_id/subgroup_id for persistence
  // These fields must be preserved through normalization
  const node_id = _stringOrNull(raw.node_id);
  const subgroup_id = _stringOrNull(raw.subgroup_id);

  const normalized = {
    id: artifact_id || requestId, // Unique identifier (artifact_id for chunks, requestId for markers)
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
    requestId, // Canonical identifier
    recipient, // CRITICAL: null if not provided, NOT defaulted
    start: Boolean(raw.start),
    end: Boolean(raw.end),
    timestamp,
    metadata
  };

  // Only include trail linkage fields if they exist
  if (node_id) normalized.node_id = node_id;
  if (subgroup_id) normalized.subgroup_id = subgroup_id;

  return normalized;
}

function validateArtifactStreamPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Artifact stream payload must be an object');
  }

  ARTIFACT_STREAM_SCHEMA.required.forEach((field) => {
    if (!_stringOrNull(payload[field])) {
      throw new Error(`Artifact stream payload missing ${field}`);
    }
  });

  if (!payload.role || typeof payload.role !== 'string') {
    throw new Error('Artifact stream payload missing or invalid role');
  }
  if (!payload.type || typeof payload.type !== 'string') {
    throw new Error('Artifact stream payload missing or invalid type');
  }
  const role = payload.role.toLowerCase();
  const type = payload.type.toLowerCase();

  if (!ARTIFACT_STREAM_SCHEMA.enums.role.includes(role)) {
    throw new Error(`Invalid artifact role: ${payload.role}`);
  }
  if (!ARTIFACT_STREAM_SCHEMA.enums.type.includes(type)) {
    throw new Error(`Invalid artifact type: ${payload.type}`);
  }

  return true;
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
  const role = payload.role;
  const type = payload.type;

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

function enforceArtifactSizeLimit(content = '') {
  if (typeof content !== 'string') {
    return { content: '', truncated: false };
  }

  if (content.length <= MAX_ARTIFACT_SIZE) {
    return { content, truncated: false };
  }

  return {
    content: content.slice(0, MAX_ARTIFACT_SIZE),
    truncated: true
  };
}

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
      `Must be 'code' (assistant writes) or 'output' (computer produces). ` +
      `Use format field to specify language/rendering type.`
    );
  }
  return normalized;
}

module.exports = {
  ARTIFACT_STREAM_SCHEMA,
  MAX_ARTIFACT_SIZE,
  normalizeArtifactStreamPayload,
  validateArtifactStreamPayload,
  resolvePhaseKindFromPayload,
  getArtifactVariantKey,
  enforceArtifactSizeLimit
};
