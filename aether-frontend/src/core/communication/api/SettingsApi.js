'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, SettingsManager, SettingsRepository --- {method_call, javascript_api}
 * Processing: Dispatch settings/preferences HTTP requests with custom retry/header logic --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/settings/*, /v1/preferences/*, /v1/proactive/config --- {http_request, json}
 *
 * @module core/communication/api/SettingsApi
 */

const BaseApi = require('./BaseApi');

class SettingsApi extends BaseApi {
  /**
   * Get settings.
   * @param {Object} [options] - Request options (correlationId, headers, etc.)
   * @returns {Promise<Object>}
   */
  async getSettings(options = {}) {
    const requestOptions = this._prepareSettingsRequestOptions(options);
    try {
      return await this._api.get('/v1/settings/', requestOptions);
    } catch (error) {
      if (!error.isBackendUnavailableError) {
        this._log.error('GET /v1/settings/ failed', this._buildSettingsErrorMeta(error, requestOptions));
      }
      throw error;
    }
  }

  /**
   * Update settings.
   * @param {Object} settings - Settings payload
   * @param {Object} [options] - Request options
   * @returns {Promise<Object>}
   */
  async setSettings(settings, options = {}) {
    const requestOptions = this._prepareSettingsRequestOptions(options);
    try {
      return await this._api.post('/v1/settings/', settings, requestOptions);
    } catch (error) {
      if (!error.isBackendUnavailableError) {
        this._log.error('POST /v1/settings/ failed', this._buildSettingsErrorMeta(error, requestOptions));
      }
      throw error;
    }
  }

  /**
   * Get user preferences (user-configurable settings).
   * @returns {Promise<Object>}
   */
  async getUserPreferences() {
    return this._request('GET', '/v1/settings/user');
  }

  /**
   * Get all user preferences from preferences table.
   * @param {string} [userId='default_user'] - User identifier
   * @returns {Promise<Object>} Object mapping preference keys to values
   */
  async getAllPreferences(userId = 'default_user') {
    const path = `/v1/preferences/?user_id=${encodeURIComponent(userId)}`;
    try {
      const response = await this._api.get(path);
      return response?.preferences || {};
    } catch (error) {
      if (!error.isBackendUnavailableError) {
        this._log.error('GET /v1/preferences failed', {
          error: error?.message || error,
          userId
        });
      }
      throw error;
    }
  }

  /**
   * Get a specific user preference.
   * @param {string} preferenceKey - Preference identifier (e.g., 'auto_summarize')
   * @param {string} [userId='default_user'] - User identifier
   * @returns {Promise<any>} Preference value
   */
  async getPreference(preferenceKey, userId = 'default_user') {
    this._requireParam(preferenceKey, 'preferenceKey', 'getPreference');
    const path = `/v1/preferences/${encodeURIComponent(preferenceKey)}?user_id=${encodeURIComponent(userId)}`;
    try {
      const response = await this._api.get(path);
      return response?.preference_value;
    } catch (error) {
      if (!error.isBackendUnavailableError) {
        this._log.error(`GET /v1/preferences/${preferenceKey} failed`, {
          error: error?.message || error,
          preferenceKey,
          userId
        });
      }
      throw error;
    }
  }

  /**
   * Set a user preference.
   * Security: value is NOT logged to prevent sensitive data leakage.
   * @param {string} preferenceKey - Preference identifier
   * @param {any} value - Preference value (any JSON-serializable type)
   * @param {string} [userId='default_user'] - User identifier
   * @returns {Promise<Object>} Updated preference
   */
  async setPreference(preferenceKey, value, userId = 'default_user') {
    this._requireParam(preferenceKey, 'preferenceKey', 'setPreference');
    const path = `/v1/preferences/${encodeURIComponent(preferenceKey)}?user_id=${encodeURIComponent(userId)}`;
    try {
      return await this._api.post(path, { value });
    } catch (error) {
      if (!error.isBackendUnavailableError) {
        this._log.error(`POST /v1/preferences/${preferenceKey} failed`, {
          error: error?.message || error,
          preferenceKey,
          valueType: typeof value,
          userId
        });
      }
      throw error;
    }
  }

  /**
   * Get user settings metadata (for UI rendering).
   * @returns {Promise<Array>}
   */
  async getUserSettingsMetadata() {
    return this._request('GET', '/v1/settings/user/metadata');
  }

  // ===========================================================================
  // Proactive Pipeline Configuration
  // ===========================================================================

  /**
   * Get proactive pipeline configuration.
   * @returns {Promise<Object>} { enabled, query_generation_enabled, ... }
   */
  async getProactiveConfig() {
    return this._request('GET', '/v1/proactive/config');
  }

  /**
   * Update proactive pipeline configuration (partial update).
   * @param {Object} config - Fields to update (e.g. { enabled, query_generation_enabled })
   * @returns {Promise<Object>}
   */
  async updateProactiveConfig(config) {
    return this._request('PATCH', '/v1/proactive/config', { body: config });
  }

  /**
   * Get proactive source readiness status (browser, email, filesystem).
   * Used by onboarding Knowledge step to pre-configure data sources.
   * Auto-delegated by Endpoint._composeModules() — no facade wiring needed.
   * @param {Object} [requestOptions] - Extra options forwarded to ApiClient (e.g. signal, timeout)
   * @returns {Promise<Object>} Source status with per-source error fields
   */
  async getProactiveSourceStatus(requestOptions = {}) {
    return this._request('GET', '/v1/proactive/source-status', requestOptions);
  }

  /**
   * Record legal acceptance event for onboarding completion.
   * Backend writes immutable audit row + latest preference snapshot.
   * @param {Object} payload - { terms_version, terms_hash, acceptance_method, ... }
   * @returns {Promise<Object>}
   */
  async recordLegalAcceptance(payload) {
    return this._request('POST', '/v1/preferences/legal/acceptance', { body: payload });
  }

  /**
   * Read latest legal acceptance from backend source-of-truth endpoint.
   * Backend resolves from immutable audit records and refreshes cache as needed.
   * @returns {Promise<Object>}
   */
  async getLatestLegalAcceptance() {
    return this._request('GET', '/v1/preferences/legal/acceptance/latest');
  }

  // ===========================================================================
  // Private helpers (settings-specific request option logic)
  // ===========================================================================

  _prepareSettingsRequestOptions(options = {}) {
    const defaults = {
      retries: 0,
      retryStatusCodes: [],
      rateCategory: 'settings',
      headers: {}
    };

    if (options.correlationId) {
      defaults.headers['X-Correlation-Id'] = options.correlationId;
    }

    if (!defaults.headers['X-Aether-Client']) {
      defaults.headers['X-Aether-Client'] = 'frontend-main';
    }

    return this._mergeRequestOptions(defaults, options);
  }

  _mergeRequestOptions(defaultOptions, overrides = {}) {
    const merged = { ...defaultOptions, ...overrides };
    merged.headers = {
      ...(defaultOptions.headers || {}),
      ...(overrides.headers || {})
    };
    if (overrides.correlationId && !merged.headers['X-Correlation-Id']) {
      merged.headers['X-Correlation-Id'] = overrides.correlationId;
    }
    return merged;
  }

  _buildSettingsErrorMeta(error, requestOptions = {}) {
    const headers = requestOptions.headers || {};
    return {
      error: error?.message || error,
      status: error?.status || undefined,
      correlationId: headers['X-Correlation-Id'] || requestOptions.correlationId || null
    };
  }
}

module.exports = SettingsApi;
