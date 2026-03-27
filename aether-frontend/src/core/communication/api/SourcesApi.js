'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, IndexBrowserModal, BrowserHistoryManager --- {method_call, javascript_api}
 * Processing: Dispatch source integration and index search HTTP requests --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/sources/*, /v1/index/*, /v1/search/index* --- {http_request, json}
 *
 * @module core/communication/api/SourcesApi
 */

const BaseApi = require('./BaseApi');

class SourcesApi extends BaseApi {
  // ===========================================================================
  // Source Integrations
  // ===========================================================================

  /**
   * List local source integrations and registered source indexes.
   * @returns {Promise<Object>}
   */
  async getSources() {
    return this._request('GET', '/v1/sources');
  }

  /**
   * List available source integrations and registered indexes.
   * Alias for getSources() - preserved for backward compatibility.
   * @returns {Promise<Object>} { sources: {}, indexes: [] }
   */
  async listSources() {
    return this._request('GET', '/v1/sources');
  }

  /**
   * Discover available browser profiles (without indexing).
   * @param {Object} [payload] - { browser: string, user_data_dir?: string }
   * @returns {Promise<Object>} { profiles: [], total_estimated_entries }
   */
  async discoverBrowserProfiles(payload = {}) {
    return this._request('POST', '/v1/sources/browser-history/discover', { body: payload });
  }

  /**
   * Build or rebuild a Chromium browser history source index.
   * @param {Object} [payload]
   * @returns {Promise<Object>}
   */
  async buildBrowserHistorySourceIndex(payload = {}) {
    return this._request('POST', '/v1/sources/browser-history/index', {
      body: payload,
      headers: { 'Cache-Control': 'no-cache' }
    });
  }

  /**
   * Build or rebuild an email source index (eml/mbox).
   * @param {Object} [payload]
   * @returns {Promise<Object>}
   */
  async buildEmailSourceIndex(payload = {}) {
    return this._request('POST', '/v1/sources/email/index', { body: payload });
  }

  // ===========================================================================
  // Custom Source Indexing (user-uploaded files/folders/zips)
  // ===========================================================================

  /**
   * Start building a custom source index from user-selected file paths.
   * Returns immediately — caller polls getSourceIndexStatus() for progress.
   *
   * @param {Object} payload
   * @param {string[]} payload.file_paths - Local filesystem paths (files, dirs, zips)
   * @param {string}   payload.index_name - Machine-safe name for the index
   * @param {string}   payload.display_name - Human-friendly display name
   * @param {string}   [payload.index_mode='combined'] - Index mode: 'semantic', 'bm25', or 'combined'
   * @param {number}   [payload.chunk_size] - Text chunk size
   * @param {number}   [payload.chunk_overlap] - Chunk overlap
   * @param {boolean}  [payload.force_rebuild=false] - Overwrite existing index
   * @returns {Promise<Object>} { success, index_name, state, files_total }
   */
  async buildCustomSourceIndex(payload = {}) {
    if (!payload.file_paths || !Array.isArray(payload.file_paths) || payload.file_paths.length === 0) {
      throw new Error('[Endpoint] file_paths[] is required for buildCustomSourceIndex');
    }
    if (!payload.index_name) {
      throw new Error('[Endpoint] index_name is required for buildCustomSourceIndex');
    }
    if (!payload.display_name) {
      throw new Error('[Endpoint] display_name is required for buildCustomSourceIndex');
    }
    return this._request('POST', '/v1/sources/custom/index', { body: payload });
  }

  /**
   * Poll the progress of a background indexing job.
   *
   * @param {string} indexName - The index name to check status for
   * @returns {Promise<Object>} { index_name, state, progress_pct, files_total, files_processed, chunk_count, error }
   */
  async getSourceIndexStatus(indexName) {
    this._requireParam(indexName, 'indexName', 'getSourceIndexStatus');
    return this._request('GET', `/v1/sources/index-status/${encodeURIComponent(indexName)}`);
  }

  /**
   * List all in-flight indexing jobs (queued or processing).
   *
   * Used on modal re-open to recover progress visibility for jobs that
   * were started in a previous modal session but haven't completed yet.
   *
   * @returns {Promise<Array<Object>>} Array of job status dicts
   */
  async getActiveIndexingJobs() {
    return this._request('GET', '/v1/sources/active-jobs');
  }

  /**
   * Delete a registered source index (files + registry entry).
   *
   * @param {string} indexName - The index name to delete
   * @returns {Promise<Object>} { success, index_name, deleted }
   */
  async deleteSourceIndex(indexName) {
    this._requireParam(indexName, 'indexName', 'deleteSourceIndex');
    return this._request('DELETE', `/v1/sources/${encodeURIComponent(indexName)}`);
  }

  // ===========================================================================
  // Index Management & Search
  // ===========================================================================

  /**
   * List all AetherRag indexes.
   * @returns {Promise<Object|Array>}
   */
  async listIndexes() {
    return this._request('GET', '/v1/index/list');
  }

  /**
   * Search a specific index.
   * @param {string} indexName - Index name (REQUIRED)
   * @param {Object} [options] - { query, topK, minScore, mode }
   * @returns {Promise<Object>}
   */
  async searchIndex(indexName, options = {}) {
    this._requireParam(indexName, 'indexName', 'searchIndex');
    const params = new URLSearchParams({
      name: indexName,
      query: options.query || ''
    });
    if (options.topK) params.append('top_k', String(options.topK));
    if (options.minScore !== undefined) params.append('min_score', String(options.minScore));
    if (options.mode) params.append('mode', options.mode);
    return this._request('GET', `/v1/search/index?${params.toString()}`, {
      logContext: { indexName }
    });
  }

  /**
   * Search multiple indexes.
   * @param {Object} payload - Must contain query
   * @param {Object} [requestOptions] - Extra options forwarded to ApiClient (e.g. signal, timeout)
   * @returns {Promise<Object>}
   */
  async searchIndexes(payload, requestOptions = {}) {
    if (!payload || !payload.query) {
      throw new Error('[Endpoint] query is required for searchIndexes');
    }
    return this._request('POST', '/v1/search/indexes', {
      body: payload,
      logContext: { queryLength: payload.query?.length },
      ...requestOptions
    });
  }

  /**
   * Log UI activity (e.g. document reading, notes typing) to trigger proactive agent.
   * @param {Object} payload - { url, title, text_content }
   * @returns {Promise<Object>}
   */
  async logActivity(payload) {
    if (!payload || !payload.url) {
      throw new Error('[Endpoint] url is required for logActivity');
    }
    return this._request('POST', '/v1/sources/activity/log', { body: payload });
  }
}

module.exports = SourcesApi;
