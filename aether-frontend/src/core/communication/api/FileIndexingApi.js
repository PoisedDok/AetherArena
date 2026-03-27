'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, FileIndexingManager, ProactiveDaemonManager --- {method_call, javascript_api}
 * Processing: Dispatch file indexing location CRUD, reindex job lifecycle, daemon management, and search HTTP requests --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/file/*, /v1/search/files --- {http_request, json}
 *
 * @module core/communication/api/FileIndexingApi
 */

const BaseApi = require('./BaseApi');

class FileIndexingApi extends BaseApi {
  // ===========================================================================
  // Location CRUD
  // ===========================================================================

  /**
   * Get all file indexing locations.
   * @param {boolean} [enabledOnly=false] - Only return enabled locations
   * @returns {Promise<Object>}
   */
  async getFileIndexingLocations(enabledOnly = false) {
    const params = enabledOnly ? '?enabled_only=true' : '';
    return this._request('GET', `/v1/file/location/list${params}`);
  }

  /**
   * Create a new file indexing location.
   * @param {Object} locationData - Location configuration
   * @returns {Promise<Object>}
   */
  async createFileIndexingLocation(locationData) {
    return this._request('POST', '/v1/file/location/create', { body: locationData });
  }

  /**
   * Get a single file indexing location.
   * @param {string} locationId - Location UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async getFileIndexingLocation(locationId) {
    this._requireParam(locationId, 'locationId', 'getFileIndexingLocation');
    const path = this._encodePath('/v1/file/location/get/:id', { id: locationId });
    return this._request('GET', path, { logContext: { locationId } });
  }

  /**
   * Update a file indexing location.
   * @param {string} locationId - Location UUID (REQUIRED)
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>}
   */
  async updateFileIndexingLocation(locationId, updates) {
    this._requireParam(locationId, 'locationId', 'updateFileIndexingLocation');
    const path = this._encodePath('/v1/file/location/update/:id', { id: locationId });
    return this._request('PUT', path, { body: updates, logContext: { locationId } });
  }

  /**
   * Delete a file indexing location.
   * @param {string} locationId - Location UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async deleteFileIndexingLocation(locationId) {
    this._requireParam(locationId, 'locationId', 'deleteFileIndexingLocation');
    const path = this._encodePath('/v1/file/location/delete/:id', { id: locationId });
    return this._request('DELETE', path, { logContext: { locationId } });
  }

  /**
   * Get the active reindex job for a location (running/queued/paused).
   * Returns { job_id, status, ... } if active, or { job_id: null } if none.
   * @param {string} locationId - Location UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async getActiveJobForLocation(locationId) {
    this._requireParam(locationId, 'locationId', 'getActiveJobForLocation');
    const path = this._encodePath('/v1/file/location/active-job/:id', { id: locationId });
    return this._request('GET', path, { logContext: { locationId } });
  }

  // ===========================================================================
  // Reindex Job Lifecycle
  // ===========================================================================

  /**
   * Trigger async reindex for a file indexing location (returns job_id immediately).
   * @param {string} locationId - Location UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async triggerFileIndexingReindex(locationId) {
    this._requireParam(locationId, 'locationId', 'triggerFileIndexingReindex');
    const path = this._encodePath('/v1/file/location/reindex/:id', { id: locationId });
    return this._request('POST', path, { body: null, logContext: { locationId } });
  }

  /**
   * Get reindex job status.
   * @param {string} jobId - Job UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async getReindexJobStatus(jobId) {
    this._requireParam(jobId, 'jobId', 'getReindexJobStatus');
    const path = this._encodePath('/v1/file/reindex/status/:id', { id: jobId });
    return this._request('GET', path, { logContext: { jobId } });
  }

  /**
   * Pause reindex job.
   * @param {string} jobId - Job UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async pauseReindexJob(jobId) {
    this._requireParam(jobId, 'jobId', 'pauseReindexJob');
    const path = this._encodePath('/v1/file/reindex/pause/:id', { id: jobId });
    return this._request('POST', path, { logContext: { jobId } });
  }

  /**
   * Resume reindex job.
   * @param {string} jobId - Job UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async resumeReindexJob(jobId) {
    this._requireParam(jobId, 'jobId', 'resumeReindexJob');
    const path = this._encodePath('/v1/file/reindex/resume/:id', { id: jobId });
    return this._request('POST', path, { logContext: { jobId } });
  }

  /**
   * Stop reindex job (saves checkpoint).
   * @param {string} jobId - Job UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async stopReindexJob(jobId) {
    this._requireParam(jobId, 'jobId', 'stopReindexJob');
    const path = this._encodePath('/v1/file/reindex/stop/:id', { id: jobId });
    return this._request('POST', path, { logContext: { jobId } });
  }

  /**
   * Cancel reindex job (discards progress).
   * @param {string} jobId - Job UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async cancelReindexJob(jobId) {
    this._requireParam(jobId, 'jobId', 'cancelReindexJob');
    const path = this._encodePath('/v1/file/reindex/cancel/:id', { id: jobId });
    return this._request('DELETE', path, { logContext: { jobId } });
  }

  // ===========================================================================
  // File Search
  // ===========================================================================

  /**
   * Search indexed files across all enabled locations.
   * @param {string} query - Search query (min 3 chars)
   * @param {Object}  [options]
   * @param {number}  [options.top_k=10]  - Max results (1-50)
   * @param {string}  [options.mode='bm25'] - 'semantic' | 'bm25' | 'hybrid'
   * @returns {Promise<{results: Array, total_found: number, search_duration_ms: number, locations_searched: string[], mode: string}>}
   */
  async searchIndexedFiles(query, options = {}) {
    this._requireParam(query, 'query', 'searchIndexedFiles');
    const params = new URLSearchParams({ query, ...options });
    return this._request('GET', `/v1/search/files?${params}`, {
      logContext: { query, mode: options.mode || 'bm25' }
    });
  }

  // ===========================================================================
  // Daemon Management
  // ===========================================================================

  /**
   * Get file indexing service health.
   * @returns {Promise<Object>}
   */
  async getFileIndexingHealth() {
    return this._request('GET', '/v1/file/health');
  }

  /**
   * Get file indexing daemon status.
   * @returns {Promise<Object>}
   */
  async getFileIndexingDaemonStatus() {
    return this._request('GET', '/v1/file/daemon/status');
  }

  /**
   * Get file indexing daemon configuration.
   * @returns {Promise<Object>}
   */
  async getFileIndexingDaemonConfig() {
    return this._request('GET', '/v1/file/daemon/config');
  }

  /**
   * Update file indexing daemon configuration.
   * @param {Object} config - Daemon configuration
   * @returns {Promise<Object>}
   */
  async updateFileIndexingDaemonConfig(config) {
    return this._request('POST', '/v1/file/daemon/config', { body: config });
  }

  /**
   * Restart file indexing daemon.
   * @returns {Promise<Object>}
   */
  async restartFileIndexingDaemon() {
    return this._request('POST', '/v1/file/daemon/restart');
  }

  /**
   * Stop file indexing daemon.
   * @returns {Promise<Object>}
   */
  async stopFileIndexingDaemon() {
    return this._request('POST', '/v1/file/daemon/stop');
  }

  /**
   * Start file indexing daemon.
   * @returns {Promise<Object>}
   */
  async startFileIndexingDaemon() {
    return this._request('POST', '/v1/file/daemon/start');
  }
}

module.exports = FileIndexingApi;
