'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, ModelManager, ProfileManager, StopController --- {method_call, javascript_api}
 * Processing: Dispatch model/profile/stop-generation HTTP requests --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/models*, /v1/profiles*, /v1/stop-generation --- {http_request, json}
 *
 * @module core/communication/api/ModelProfileApi
 */

const BaseApi = require('./BaseApi');

class ModelProfileApi extends BaseApi {
  /**
   * List available models.
   * @param {string} [apiBaseOverride] - Optional API base override
   * @returns {Promise<Array>}
   */
  async getModels(apiBaseOverride = null) {
    const query = apiBaseOverride ? `?base=${encodeURIComponent(apiBaseOverride)}` : '';
    return this._request('GET', `/v1/models${query}`, {
      logContext: { baseOverride: apiBaseOverride || undefined }
    });
  }

  /**
   * Get model capabilities.
   * CONTRACT: modelName is REQUIRED - fail-fast if missing.
   * @param {string} modelName - Model name (REQUIRED)
   * @returns {Promise<Object>}
   */
  async getModelCapabilities(modelName) {
    if (!modelName || typeof modelName !== 'string' || modelName.trim().length === 0) {
      throw new Error('[Endpoint] CONTRACT VIOLATION: modelName is required and must be a non-empty string');
    }
    const encoded = encodeURIComponent(modelName);
    return this._request('GET', `/v1/models/capabilities?model=${encoded}`, {
      logContext: { model: modelName }
    });
  }

  /**
   * List available profiles.
   * @param {boolean} [refresh=false] - Force refresh
   * @returns {Promise<Array>}
   */
  async getProfiles(refresh = false) {
    const query = refresh ? '?refresh=true' : '';
    return this._request('GET', `/v1/profiles${query}`);
  }

  /**
   * Get profile details.
   * CONTRACT: profileName is REQUIRED - fail-fast if missing.
   * @param {string} profileName - Profile name (REQUIRED)
   * @returns {Promise<Object>}
   */
  async getProfileDetails(profileName) {
    if (!profileName || typeof profileName !== 'string' || profileName.trim().length === 0) {
      throw new Error('[Endpoint] CONTRACT VIOLATION: profileName is required and must be a non-empty string');
    }
    const path = this._encodePath('/v1/profiles/:name', { name: profileName });
    return this._request('GET', path, { logContext: { profile: profileName } });
  }

  /**
   * Stop current generation.
   * @param {Object} [options] - { requestId, sessionId }
   * @returns {Promise<Object>}
   */
  async stopGeneration(options = {}) {
    const payload = {};
    if (options.requestId) payload.request_id = options.requestId;
    if (options.sessionId) payload.session_id = options.sessionId;
    return this._request('POST', '/v1/stop-generation', { body: payload });
  }
}

module.exports = ModelProfileApi;
