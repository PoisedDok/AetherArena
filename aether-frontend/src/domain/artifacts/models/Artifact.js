'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsStreamOrchestrator, MessageState, PostgreSQL queries --- {stream_data | database_types.artifact_record, json}
 * Processing: Immutable artifact domain model - 4 types (code/output/html/file), traceability linkage (sourceMessageId, correlationId, chatId), trail hierarchy linkage (subgroupId, nodeId), id generation (art_timestamp_random), filename generation, format→language mapping (py→python, js→javascript, etc), PostgreSQL schema conversion (snake_case ↔ camelCase) --- {3 jobs: JOB_VALIDATE_SCHEMA, JOB_TRACK_ENTITY, JOB_GENERATE_SESSION_ID}
 * Outgoing: Export frozen artifact instance or JSON/PostgreSQL formatted data --- {artifact_types.*, Artifact}
 * 
 * 
 * @module domain/artifacts/models/Artifact
 */

class Artifact {
  constructor(data = {}) {
    // Core identity
    this.id = data.id || this._generateId();
    this.artifact_id = data.artifact_id || null; // CRITICAL: Frontend dedup key from backend
    this.type = data.type || 'code'; // 'code' | 'output' | 'html' | 'file'
    this.format = data.format || 'text'; // Language or file extension
    this.content = data.content || '';
    
    // Temporal tracking
    this.timestamp = data.timestamp || Date.now();
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || null;
    
    // Traceability linkage
    this.sourceMessageId = data.sourceMessageId || null;
    this.correlationId = data.correlationId || null;
    this.chatId = data.chatId || null;
    
    // Trail hierarchy linkage (for code/output artifacts)
    this.subgroupId = data.subgroupId || data.subgroup_id || null;
    this.nodeId = data.nodeId || data.node_id || null;
    
    // Execution group linkage (groups code+output pairs)
    this.executionGroup = data.executionGroup || data.execution_group || null;
    
    // File system mapping
    this.fileName = data.fileName || null;
    this.filePath = data.filePath || null;
    
    // Metadata and state
    this.metadata = Object.freeze({ ...(data.metadata || {}) });
    this.status = data.status || 'active'; // 'streaming' | 'active' | 'archived' | 'deleted'
    
    // PostgreSQL backend mapping
    this.serverId = data.serverId || null; // UUID from backend
    this.language = data.language || null; // For code artifacts
    
    Object.freeze(this);
  }

  /**
   * Generate unique artifact ID
   * Format: art_<timestamp>_<random>
   */
  _generateId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 11);
    return `art_${timestamp}_${random}`;
  }

  /**
   * Generate unique artifact ID with kind suffix
   * Ensures different artifact types have unique IDs
   */
  static generateIdWithKind(baseId, kind) {
    return `${baseId}_${kind}`;
  }

  /**
   * Generate filename from artifact properties
   */
  generateFileName() {
    const timestamp = new Date(this.timestamp)
      .toISOString()
      .replace(/[:.]/g, '-')
      .substring(0, 19);
    const ext = this._resolveExtension();
    return `${this.type}_${timestamp}.${ext}`;
  }

  /**
   * Resolve file extension from artifact type and format
   */
  _resolveExtension() {
    const extMap = {
      code: this.format || 'txt',
      output: 'txt',
      html: 'html',
      file: this.format || 'txt'
    };
    return extMap[this.type] || 'txt';
  }

  /**
   * Map format to programming language
   */
  resolveLanguage() {
    if (this.type !== 'code') return null;
    
    const langMap = {
      'py': 'python',
      'python': 'python',
      'js': 'javascript',
      'javascript': 'javascript',
      'ts': 'typescript',
      'typescript': 'typescript',
      'jsx': 'javascript',
      'tsx': 'typescript',
      'html': 'html',
      'css': 'css',
      'json': 'json',
      'md': 'markdown',
      'markdown': 'markdown',
      'txt': 'text',
      'sh': 'shell',
      'bash': 'shell',
      'sql': 'sql',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'go': 'go',
      'rust': 'rust',
      'rb': 'ruby',
      'php': 'php'
    };
    
    return langMap[this.format] || this.format;
  }

  /**
   * Check if artifact has valid message linkage
   */
  hasMessageLink() {
    return this.sourceMessageId !== null;
  }

  /**
   * Check if artifact is persisted to backend
   */
  isPersisted() {
    return this.serverId !== null;
  }

  /**
   * Check if artifact content is empty
   */
  isEmpty() {
    return !this.content || this.content.trim().length === 0;
  }

  /**
   * Check if artifact is streamable type
   */
  isStreamable() {
    return ['code', 'output', 'html'].includes(this.type);
  }

  /**
   * Create new artifact with updated properties (immutable)
   */
  update(updates) {
    return new Artifact({
      ...this.toJSON(),
      ...updates,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * Create new artifact with different status
   */
  withStatus(status) {
    return this.update({ status });
  }

  /**
   * Create new artifact with server ID
   */
  withServerId(serverId) {
    return this.update({ serverId });
  }

  /**
   * Create new artifact with message link
   */
  withMessageLink(sourceMessageId, correlationId = null) {
    return this.update({ sourceMessageId, correlationId });
  }

  /**
   * Serialize to plain object for storage
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      format: this.format,
      content: this.content,
      timestamp: this.timestamp,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      sourceMessageId: this.sourceMessageId,
      correlationId: this.correlationId,
      chatId: this.chatId,
      subgroupId: this.subgroupId,  // Trail linkage
      nodeId: this.nodeId,          // Trail linkage
      executionGroup: this.executionGroup,  // Execution unit pairing
      fileName: this.fileName,
      filePath: this.filePath,
      metadata: { ...this.metadata },
      status: this.status,
      serverId: this.serverId,
      language: this.language
    };
  }

  /**
   * Serialize to PostgreSQL artifact format
   */
  toPostgreSQLFormat() {
    // ARCHITECTURE: Convert to backend ArtifactCreate schema (snake_case)
    // Must include trail linkage for code/output artifacts
    return {
      type: this.type,
      filename: this.fileName || this.generateFileName(),
      content: this.content,
      language: this.language || this.resolveLanguage(),
      artifact_id: this.id,
      message_id: this.sourceMessageId,
      chat_id: this.chatId,
      subgroup_id: this.subgroupId || null,  // Trail linkage (required for output artifacts)
      node_id: this.nodeId || null,          // Trail linkage (required for output artifacts)
      execution_group: this.executionGroup || null, // Execution unit pairing
      metadata: {
        ...this.metadata,
        format: this.format,
        createdAt: this.createdAt,
        correlationId: this.correlationId,
        execution_group: this.executionGroup // Also in metadata for legacy compatibility
      }
    };
  }

  /**
   * Create artifact from JSON object
   */
  static fromJSON(data) {
    return new Artifact(data);
  }

  /**
   * Create artifact from PostgreSQL row
   */
  static fromPostgreSQLRow(row) {
    // ARCHITECTURE: Parse PostgreSQL/Backend API format (snake_case)
    // Backend contract: chat_id, artifact_id, message_id, created_at, updated_at, subgroup_id, node_id
    // CRITICAL FIX: row.id is PostgreSQL UUID, row.artifact_id is frontend key
    // The normalizer expects raw backend format with id (UUID) and created_at present
    //
    // SCHEMA NOTE: ArtifactResponse returns "title" (set from filename during creation),
    // NOT "filename" directly. We check both for compatibility.
    return new Artifact({
      id: row.id || row.artifact_id,  // FIXED: Prioritize PostgreSQL UUID
      artifact_id: row.artifact_id,    // ADDED: Preserve frontend key
      type: row.type,
      format: row.metadata?.format || row.language || 'text',
      content: row.content || '',
      timestamp: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
      createdAt: row.created_at,
      created_at: row.created_at,      // ADDED: Normalizer expects snake_case
      updatedAt: row.updated_at,
      sourceMessageId: row.message_id,
      correlationId: row.metadata?.correlationId,
      chatId: row.chat_id,  // STRICT: Backend always sends snake_case
      subgroupId: row.subgroup_id,  // Trail linkage
      nodeId: row.node_id,          // Trail linkage
      // ARCHITECTURAL FIX: ArtifactResponse returns "title" (derived from filename at creation),
      // not "filename". Map both to ensure filenames survive the round-trip.
      fileName: row.filename || row.title || null,
      // ARCHITECTURAL FIX: Map execution_group from top-level field (DB column)
      // or fallback to metadata for legacy artifacts
      executionGroup: row.execution_group || (row.metadata?.execution_group) || (row.metadata?.executionGroup) || null,
      metadata: row.metadata || {},
      status: 'active',
      serverId: row.id,
      language: row.language
    });
  }

  /**
   * Create artifact from stream data
   */
  static fromStreamData(streamData) {
    const { id, kind, content, format, language, sourceMessageId, correlationId, chatId, metadata } = streamData;
    
    return new Artifact({
      id,
      type: kind || 'code',
      format: format || language || kind || 'text',
      content: content || '',
      language: language || null,
      sourceMessageId,
      correlationId,
      chatId,
      metadata: metadata || {},
      status: 'streaming'
    });
  }

  /**
   * Create empty artifact placeholder
   */
  static createPlaceholder(type = 'code') {
    return new Artifact({
      type,
      status: 'streaming',
      content: ''
    });
  }
}

module.exports = { Artifact };
