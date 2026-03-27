'use strict';

/**
 * @.architecture
 * Incoming: Domain API modules (HealthApi, SettingsApi, AgentApi, etc.) --- {method_call, javascript_api}
 * Processing: Provide shared HTTP request dispatch, parameter validation, path encoding, query building --- {4 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA, JOB_ENCODE_PATH, JOB_BUILD_QUERY}
 * Outgoing: ApiClient.request() --- {http_request, json}
 *
 * @module core/communication/api/BaseApi
 */

/**
 * BaseApi - Shared infrastructure for all domain API modules.
 *
 * Provides:
 * - _request(): Unified HTTP dispatch with structured error logging
 * - _requireParam(): Fail-fast parameter validation
 * - _requireString(): String-specific validation with min-length
 * - _encodePath(): Safe URL path construction with encodeURIComponent
 * - _buildQuery(): Declarative query-string building from filter objects
 */
class BaseApi {
  /**
   * @param {Object} ctx - Shared context from Endpoint facade
   * @param {Object} ctx.api - ApiClient instance
   * @param {Object} ctx.logger - Child logger for Endpoint
   * @param {Object} [ctx.connection] - GuruConnection instance (optional, only MessagingApi uses it)
   * @param {Object} [ctx.config] - Endpoint config (optional)
   */
  constructor(ctx) {
    if (!ctx || !ctx.api || !ctx.logger) {
      throw new Error('[BaseApi] ctx.api and ctx.logger are required');
    }
    this._api = ctx.api;
    this._log = ctx.logger;
    this._connection = ctx.connection || null;
    this._config = ctx.config || {};
  }

  /**
   * Unified HTTP request dispatch with structured error logging.
   *
   * @param {string} method - HTTP method: GET, POST, PUT, PATCH, DELETE
   * @param {string} path - URL path (relative to ApiClient.baseURL)
   * @param {Object} [opts] - Options
   * @param {*} [opts.body] - Request body (POST/PUT/PATCH)
   * @param {Object} [opts.logContext] - Additional fields merged into error log
   * @param {Object} [opts.*] - Remaining fields forwarded to ApiClient as requestOptions
   * @returns {Promise<*>} Response data
   */
  async _request(method, path, opts = {}) {
    const { body, logContext, ...requestOptions } = opts;
    try {
      switch (method) {
        case 'GET':    return await this._api.get(path, requestOptions);
        case 'POST':   return await this._api.post(path, body, requestOptions);
        case 'PUT':    return await this._api.put(path, body, requestOptions);
        case 'PATCH':  return await this._api.patch(path, body, requestOptions);
        case 'DELETE': return await this._api.delete(path, requestOptions);
        default:
          throw new Error(`[BaseApi] Unsupported HTTP method: ${method}`);
      }
    } catch (error) {
      // Suppress logging for BackendUnavailableError — this is an expected
      // condition when skipHealthCheck=true and backend is absent. Callers
      // handle it gracefully; logging here would produce 13+ duplicate error lines.
      if (!error.isBackendUnavailableError) {
        this._log.error(`${method} ${path} failed`, {
          error: error?.message || error,
          ...(logContext || {})
        });
      }
      throw error;
    }
  }

  /**
   * Fail-fast validation for required parameters.
   * Throws immediately if value is falsy or an empty/whitespace-only string.
   *
   * @param {*} value - The parameter value
   * @param {string} name - Parameter name for error message
   * @param {string} method - Calling method name for error message
   * @throws {Error} If value is missing
   */
  _requireParam(value, name, method) {
    if (!value || (typeof value === 'string' && value.trim().length === 0)) {
      throw new Error(`[Endpoint] ${name} is required for ${method}`);
    }
  }

  /**
   * Fail-fast validation for required string parameters with optional min-length.
   *
   * @param {*} value - The parameter value
   * @param {string} name - Parameter name for error message
   * @param {string} method - Calling method name for error message
   * @param {number} [minLength=1] - Minimum trimmed length
   * @throws {Error} If value is not a string or too short
   */
  _requireString(value, name, method, minLength = 1) {
    if (!value || typeof value !== 'string' || value.trim().length < minLength) {
      throw new Error(`[Endpoint] ${name} is required for ${method}`);
    }
  }

  /**
   * Safely build a URL path by encoding all parameter values.
   * Template uses `:paramName` placeholders.
   *
   * Example: _encodePath('/v1/agent/config/:name', { name: 'my agent' })
   *       -> '/v1/agent/config/my%20agent'
   *
   * @param {string} template - URL template with :param placeholders
   * @param {Object} params - Key-value pairs to substitute
   * @returns {string} Encoded path
   */
  _encodePath(template, params) {
    let path = template;
    for (const [key, val] of Object.entries(params)) {
      path = path.replace(`:${key}`, encodeURIComponent(String(val)));
    }
    return path;
  }

  /**
   * Build a query string from a filters object using a declarative mapping.
   *
   * Example: _buildQuery({ status: 'active', limit: 10 }, { status: 'status_filter', limit: 'limit' })
   *       -> 'status_filter=active&limit=10'
   *
   * @param {Object} filters - Source object with filter values
   * @param {Object} mapping - { sourceKey: queryParamName } mapping
   * @returns {string} URL-encoded query string (without leading '?')
   */
  _buildQuery(filters, mapping) {
    const params = new URLSearchParams();
    for (const [key, paramName] of Object.entries(mapping)) {
      if (filters[key] !== undefined && filters[key] !== null) {
        params.append(paramName, String(filters[key]));
      }
    }
    return params.toString();
  }

  /**
   * Build a full path with optional query string.
   * Returns basePath if query is empty, basePath?query otherwise.
   *
   * @param {string} basePath - Base URL path
   * @param {string} query - Query string (from _buildQuery)
   * @returns {string} Full path
   */
  _pathWithQuery(basePath, query) {
    return query ? `${basePath}?${query}` : basePath;
  }
}

module.exports = BaseApi;
