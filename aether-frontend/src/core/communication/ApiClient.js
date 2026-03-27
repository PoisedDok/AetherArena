'use strict';

/**
 * @.architecture
 * 
 * Incoming: Application modules (ApiService.js, Endpoint.js, ModelManager.js, ProfileManager.js, SettingsManager.js) --- {http_request_config, json}
 * Processing: Initialize client, execute HTTP via fetch with timeout, stringify request body, parse response JSON, check rate limiter, update circuit breaker state, retry with exponential backoff --- {6 jobs: JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_INITIALIZE, JOB_PARSE_JSON, JOB_STRINGIFY_JSON, JOB_UPDATE_STATE}
 * Outgoing: Backend REST API (config.backend.baseUrl + /v1/*) --- {http_response, json}
 * 
 * 
 * @module core/communication/ApiClient
 * 
 * ApiClient - Production HTTP Client
 * ============================================================================
 * Features:
 * - Automatic retries with exponential backoff
 * - Circuit breaker pattern
 * - Client-side rate limiting
 * - Request/response interceptors
 * - Timeout handling
 * - AbortSignal support
 * - Type-safe error handling
 */

const { createLogger } = require('../utils/logger');
const { freeze } = Object;
const { RateLimiter, RateLimitError } = require('../security/RateLimiter');

// ============================================================================
// Error Classes
// ============================================================================

class ApiError extends Error {
  constructor(message, status, body, url) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.isApiError = true;
  }
}

class TimeoutError extends Error {
  constructor(message, url) {
    super(message);
    this.name = 'TimeoutError';
    this.url = url;
    this.isTimeoutError = true;
  }
}

class CircuitBreakerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.isCircuitBreakerError = true;
  }
}

class BackendUnavailableError extends Error {
  constructor(url) {
    super(`Backend unavailable (no connection expected) — ${url || 'unknown'}`);
    this.name = 'BackendUnavailableError';
    this.url = url;
    this.isBackendUnavailableError = true;
  }
}

// ============================================================================
// Circuit Breaker
// ============================================================================

class CircuitBreaker {
  constructor(options = {}) {
    this.threshold = options.threshold || 5;
    this.timeout = options.timeout || 60000;
    this.volumeThreshold = options.volumeThreshold || 10;
    
    this.state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.failureCount = 0;
    this.successCount = 0;
    this.requestCount = 0;
    this.nextAttempt = Date.now();
  }

  canRequest() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'HALF_OPEN') return true;
    if (this.state === 'OPEN' && Date.now() >= this.nextAttempt) {
      this.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }

  onSuccess() {
    this.requestCount++;
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.successCount = 0;
    }
  }

  onFailure() {
    this.requestCount++;
    this.failureCount++;
    
    if (this.requestCount < this.volumeThreshold) return;
    
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }

  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.requestCount = 0;
  }

  getState() {
    return freeze({
      state: this.state,
      failureCount: this.failureCount,
      requestCount: this.requestCount,
      nextAttempt: this.nextAttempt
    });
  }
}

// ============================================================================
// API Client
// ============================================================================

class ApiClient {
  constructor(options = {}) {
    this.baseURL = options.baseURL;
    this.timeout = options.timeout || 12000;
    this.retries = options.retries !== undefined ? options.retries : 2;
    this.retryDelay = options.retryDelay || 500;
    this.retryStatusCodes = options.retryStatusCodes || [408, 429, 500, 502, 503, 504];
    this.enableLogging = options.enableLogging || false;
    this.log = createLogger({ component: 'ApiClient' });

    // Backend availability gate: when false, all requests fail immediately
    // with BackendUnavailableError (no network call, no retries, no log spam).
    // Can be set at construction via options.backendAvailable (avoids timing race),
    // or toggled later via setBackendAvailable().
    this._backendAvailable = options.backendAvailable !== undefined
      ? Boolean(options.backendAvailable)
      : true;
    
    this.circuitBreaker = options.circuitBreaker !== false
      ? new CircuitBreaker(options.circuitBreakerOptions || {})
      : null;
    
    this.rateLimiter = options.rateLimiter !== false
      ? new RateLimiter({
          enabled: options.rateLimiter !== false,
          ...options.rateLimiterOptions
        })
      : null;
    
    this.requestInterceptors = [];
    this.responseInterceptors = [];
  }

  /**
   * Set backend availability. When false, all requests reject immediately
   * with BackendUnavailableError — no network call, no retries, no log spam.
   * @param {boolean} available
   */
  setBackendAvailable(available) {
    this._backendAvailable = Boolean(available);
    if (this.enableLogging) {
      this.log.info('backend availability changed', { available: this._backendAvailable });
    }
  }

  /**
   * @returns {boolean} Current backend availability state
   */
  isBackendAvailable() {
    return this._backendAvailable;
  }

  /**
   * Add request interceptor
   * @param {Function} interceptor - (config) => config
   */
  addRequestInterceptor(interceptor) {
    if (typeof interceptor !== 'function') {
      throw new TypeError('Interceptor must be a function');
    }
    this.requestInterceptors.push(interceptor);
  }

  /**
   * Add response interceptor
   * @param {Function} interceptor - (response) => response
   */
  addResponseInterceptor(interceptor) {
    if (typeof interceptor !== 'function') {
      throw new TypeError('Interceptor must be a function');
    }
    this.responseInterceptors.push(interceptor);
  }

  /**
   * Remove request interceptor
   * @param {Function} interceptor - The interceptor to remove
   * @returns {boolean} - True if removed, false if not found
   */
  removeRequestInterceptor(interceptor) {
    const index = this.requestInterceptors.indexOf(interceptor);
    if (index !== -1) {
      this.requestInterceptors.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Remove response interceptor
   * @param {Function} interceptor - The interceptor to remove
   * @returns {boolean} - True if removed, false if not found
   */
  removeResponseInterceptor(interceptor) {
    const index = this.responseInterceptors.indexOf(interceptor);
    if (index !== -1) {
      this.responseInterceptors.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Make HTTP request
   * @param {string} method - HTTP method
   * @param {string} url - Request URL
   * @param {Object} options - Request options
   * @returns {Promise<any>}
   */
  async request(method, url, options = {}) {
    // Backend availability gate: fail immediately without network call or retries.
    // Set via setBackendAvailable(false) when skipHealthCheck=true and no backend discovered.
    if (!this._backendAvailable) {
      const fullURL = url.startsWith('http') ? url : `${this.baseURL}${url}`;
      throw new BackendUnavailableError(fullURL);
    }

    // Check rate limiter
    if (this.rateLimiter) {
      const endpoint = this._getEndpointKey(method, url);
      const category = options.rateCategory || 'api';
      
      try {
        this.rateLimiter.check(endpoint, { category });
      } catch (error) {
        if (error.isRateLimitError) {
          if (this.enableLogging) {
            this.log.warn('rate limited', { method, url, retryAfter: error.retryAfter });
          }
          throw error;
        }
        throw error;
      }
    }
    
    // Check circuit breaker
    if (this.circuitBreaker && !this.circuitBreaker.canRequest()) {
      throw new CircuitBreakerError('Circuit breaker is OPEN');
    }

    const methodUpper = method.toUpperCase();

    // Build full URL
    const fullURL = url.startsWith('http') ? url : `${this.baseURL}${url}`;

    // Build request config
    let config = {
      method: methodUpper,
      url: fullURL,
      headers: options.headers || {},
      body: options.body,
      timeout: options.timeout || this.timeout,
      signal: options.signal,
      responseType: options.responseType
    };

    // Run request interceptors
    for (const interceptor of this.requestInterceptors) {
      config = interceptor(config) || config;
    }

    // Retry logic (idempotent-only by default; allow explicit opt-in)
    const allowRetry = options.allowRetry !== undefined
      ? Boolean(options.allowRetry)
      : this._isIdempotentMethod(methodUpper);
    let lastError;
    const maxAttempts = allowRetry
      ? (options.retries !== undefined ? options.retries : this.retries) + 1
      : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this._fetch(config);
        
        // Circuit breaker success
        if (this.circuitBreaker) {
          this.circuitBreaker.onSuccess();
        }

        // Run response interceptors
        let processedResponse = response;
        for (const interceptor of this.responseInterceptors) {
          processedResponse = interceptor(processedResponse) || processedResponse;
        }

        return processedResponse;

      } catch (error) {
        lastError = error;

        // Don't retry certain errors
        if (allowRetry && error.isTimeoutError && attempt < maxAttempts - 1) {
          // Retry timeouts
          await this._delay(this.retryDelay * Math.pow(2, attempt));
          continue;
        }

        if (error.isApiError) {
          // Retry specific status codes
          if (allowRetry && this.retryStatusCodes.includes(error.status) && attempt < maxAttempts - 1) {
            await this._delay(this.retryDelay * Math.pow(2, attempt));
            continue;
          }

          // Don't retry other status codes
          if (this.circuitBreaker) {
            this.circuitBreaker.onFailure();
          }
          throw error;
        }

        // Network errors - retry
        if (allowRetry && attempt < maxAttempts - 1) {
          await this._delay(this.retryDelay * Math.pow(2, attempt));
          continue;
        }

        // Circuit breaker failure
        if (this.circuitBreaker) {
          this.circuitBreaker.onFailure();
        }

        throw error;
      }
    }

    throw lastError;
  }

  /**
   * GET request
   */
  async get(url, options = {}) {
    try {
      return await this.request('GET', url, options);
    } catch (error) {
      if (this.enableLogging && !error.isBackendUnavailableError) {
        this.log.error('GET failed', { url, error: error.message });
      }
      throw error;
    }
  }

  /**
   * POST request
   */
  async post(url, body, options = {}) {
    try {
      return await this.request('POST', url, { ...options, body });
    } catch (error) {
      if (this.enableLogging && !error.isBackendUnavailableError) {
        this.log.error('POST failed', { url, error: error.message });
      }
      throw error;
    }
  }

  /**
   * PUT request
   */
  async put(url, body, options = {}) {
    try {
      return await this.request('PUT', url, { ...options, body });
    } catch (error) {
      if (this.enableLogging && !error.isBackendUnavailableError) {
        this.log.error('PUT failed', { url, error: error.message });
      }
      throw error;
    }
  }

  /**
   * PATCH request
   */
  async patch(url, body, options = {}) {
    try {
      return await this.request('PATCH', url, { ...options, body });
    } catch (error) {
      if (this.enableLogging && !error.isBackendUnavailableError) {
        this.log.error('PATCH failed', { url, error: error.message });
      }
      throw error;
    }
  }

  /**
   * DELETE request
   */
  async delete(url, options = {}) {
    try {
      return await this.request('DELETE', url, options);
    } catch (error) {
      if (this.enableLogging && !error.isBackendUnavailableError) {
        this.log.error('DELETE failed', { url, error: error.message });
      }
      throw error;
    }
  }

  /**
   * Get circuit breaker state
   */
  getCircuitBreakerState() {
    return this.circuitBreaker ? this.circuitBreaker.getState() : null;
  }

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker() {
    if (this.circuitBreaker) {
      this.circuitBreaker.reset();
    }
  }

  /**
   * Get rate limiter statistics
   */
  getRateLimiterStats() {
    return this.rateLimiter ? this.rateLimiter.getStats() : null;
  }

  /**
   * Reset rate limiter
   */
  resetRateLimiter() {
    if (this.rateLimiter) {
      this.rateLimiter.clear();
      this.rateLimiter.resetStats();
    }
  }

  /**
   * Dispose and release all resources
   */
  dispose() {
    this.requestInterceptors = [];
    this.responseInterceptors = [];
    if (this.circuitBreaker) {
      this.circuitBreaker.reset();
    }
    if (this.rateLimiter) {
      this.rateLimiter.clear();
    }
  }

  /**
   * Get endpoint key for rate limiting
   * @param {string} method - HTTP method
   * @param {string} url - URL
   * @returns {string}
   * @private
   */
  _getEndpointKey(method, url) {
    // Extract path from full URL
    try {
      const config = require('../config');
      const parsed = new URL(url, this.baseURL || config.backend.baseUrl);
      return `${method}:${parsed.pathname}`;
    } catch {
      return `${method}:${url}`;
    }
  }

  _isIdempotentMethod(method) {
    return method === 'GET' ||
      method === 'HEAD' ||
      method === 'OPTIONS' ||
      method === 'PUT' ||
      method === 'DELETE';
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Execute fetch with timeout
   * @private
   */
  async _fetch(config) {
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, config.timeout);
    let onExternalAbort = null;
    const detachExternalAbort = () => {
      if (config.signal && onExternalAbort) {
        config.signal.removeEventListener('abort', onExternalAbort);
        onExternalAbort = null;
      }
    };

    // Wire user-provided signal to our controller so BOTH timeout and
    // user cancellation abort the fetch.  The previous `config.signal || controller.signal`
    // short-circuit completely disabled the internal timeout when a user signal was provided.
    if (config.signal) {
      if (config.signal.aborted) {
        controller.abort(config.signal.reason);
      } else {
        onExternalAbort = () => {
          controller.abort(config.signal.reason);
        };
        config.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    try {
      const fetchOptions = {
        method: config.method,
        headers: config.headers,
        signal: controller.signal
      };

      if (config.body) {
        if (typeof config.body === 'object' && !(config.body instanceof FormData)) {
          fetchOptions.headers['Content-Type'] = 'application/json';
          fetchOptions.body = JSON.stringify(config.body);
        } else {
          fetchOptions.body = config.body;
        }
      }

      if (this.enableLogging) {
        this.log.debug('fetch request', { url: config.url });
      }
      const response = await fetch(config.url, fetchOptions);
      if (this.enableLogging) {
        this.log.debug('fetch response', { url: config.url, status: response.status });
      }

      clearTimeout(timeoutId);
      detachExternalAbort();

      // Check status first
      if (!response.ok) {
        // Read error body as text first to avoid "body used already" errors,
        // consistent with the success-path fix.
        const contentType = response.headers.get('Content-Type') || '';
        let errorBody;

        try {
          const errorText = await response.text();
          if (contentType.includes('application/json') && errorText) {
            try {
              errorBody = JSON.parse(errorText);
            } catch {
              errorBody = errorText;
            }
          } else {
            errorBody = errorText || null;
          }
        } catch {
          errorBody = null;
        }

        throw new ApiError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          errorBody,
          config.url
        );
      }

      // Parse response body (only if there is one)
      // 204 No Content has no body, don't attempt to read it
      if (response.status === 204 || response.headers.get('Content-Length') === '0') {
        return null;
      }

      const contentType = response.headers.get('Content-Type') || '';
      
      if (config.responseType === 'arraybuffer') {
        return await response.arrayBuffer();
      }

      // Always consume the body as text first to avoid the "body used already"
      // error that occurs when response.json() fails on malformed JSON and
      // the subsequent response.text() finds the stream already consumed.
      const text = await response.text();

      if (contentType.includes('application/json')) {
        try {
          const parsed = JSON.parse(text);
          // Structural guard rail: REST APIs should return Objects or Arrays, not primitives
          if (parsed !== null && typeof parsed !== 'object') {
             throw new ApiError(
               `Invalid JSON shape: expected object/array, got ${typeof parsed}`,
               response.status,
               text,
               config.url
             );
          }
          return parsed;
        } catch (e) {
          if (e.isApiError) throw e;
          // Malformed JSON — return raw text so callers can inspect it
          return text;
        }
      }

      return text;

    } catch (error) {
      clearTimeout(timeoutId);
      detachExternalAbort();

      if (error.name === 'AbortError') {
        // AbortErrors can come from two sources:
        // 1) Internal timeout controller (should be TimeoutError for retry logic)
        // 2) User-provided AbortSignal (should remain AbortError)
        //
        // If no external signal is currently aborted, treat the abort as timeout
        // to preserve timeout semantics and retry behavior.
        const externalAborted = Boolean(config.signal?.aborted);
        if (didTimeout || !externalAborted) {
          throw new TimeoutError(`Request timeout after ${config.timeout}ms`, config.url);
        }
        const reason = controller.signal.reason ?? config.signal?.reason;
        const reasonMessage = typeof reason === 'string'
          ? reason
          : reason?.message;
        const abortError = new Error(
          reasonMessage ? `Request aborted: ${reasonMessage}` : 'Request aborted'
        );
        abortError.name = 'AbortError';
        abortError.isAbortError = true;
        abortError.abortReason = reason;
        abortError.url = config.url;
        throw abortError;
      }

      throw error;
    }
  }

  /**
   * Delay helper
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export
module.exports = { ApiClient, ApiError, TimeoutError, CircuitBreakerError, CircuitBreaker, BackendUnavailableError };

if (typeof window !== 'undefined') {
  window.ApiClient = ApiClient;
  window.ApiError = ApiError;
  window.TimeoutError = TimeoutError;
  window.CircuitBreakerError = CircuitBreakerError;
  // ApiClient loaded
}
