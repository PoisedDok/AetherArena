'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, ArtifactsLibraryModal, ChatFilesModal --- {method_call, javascript_api}
 * Processing: Dispatch artifact CRUD HTTP requests --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/storage/artifact/* --- {http_request, json}
 *
 * @module core/communication/api/ArtifactApi
 */

const BaseApi = require('./BaseApi');

class ArtifactApi extends BaseApi {
  /**
   * Get artifact by ID.
   * @param {string} artifactId - Artifact UUID (REQUIRED)
   * @returns {Promise<Object>} Artifact object
   */
  async getArtifact(artifactId) {
    this._requireParam(artifactId, 'artifactId', 'getArtifact');
    const path = this._encodePath('/v1/storage/artifact/get/:id', { id: artifactId });
    return this._request('GET', path, { logContext: { artifactId } });
  }

  /**
   * Export artifact content.
   * @param {string} artifactId - Artifact UUID (REQUIRED)
   * @returns {Promise<string>} Artifact content
   */
  async exportArtifact(artifactId) {
    this._requireParam(artifactId, 'artifactId', 'exportArtifact');
    const path = this._encodePath('/v1/storage/artifact/export/:id', { id: artifactId });
    return this._request('GET', path, { responseType: 'text', logContext: { artifactId } });
  }

  /**
   * Update artifact.
   * @param {string} artifactId - Artifact UUID (REQUIRED)
   * @param {Object} updates - Fields to update (content, filename, language, metadata)
   * @returns {Promise<Object>} Updated artifact
   */
  async updateArtifact(artifactId, updates) {
    this._requireParam(artifactId, 'artifactId', 'updateArtifact');
    const path = this._encodePath('/v1/storage/artifact/update/:id', { id: artifactId });
    return this._request('PUT', path, { body: updates, logContext: { artifactId } });
  }

  /**
   * Delete artifact.
   * @param {string} artifactId - Artifact UUID (REQUIRED)
   * @returns {Promise<void>}
   */
  async deleteArtifact(artifactId) {
    this._requireParam(artifactId, 'artifactId', 'deleteArtifact');
    const path = this._encodePath('/v1/storage/artifact/delete/:id', { id: artifactId });
    return this._request('DELETE', path, { logContext: { artifactId } });
  }
}

module.exports = ArtifactApi;
