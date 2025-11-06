'use strict';

/**
 * @.architecture
 * 
 * Incoming: Application modules (Endpoint.js, ModelManager.js, ProfileManager.js, SettingsManager.js via .request/.get/.post methods) --- {http_request_options, object}
 * Processing: Execute HTTP request via fetch, apply circuit breaker/rate limiter gates, parse/stringify JSON, retry on failure with exponential backoff, run request/response interceptors, manage state --- {5 jobs: JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_INITIALIZE, JOB_PARSE_JSON, JOB_STRINGIFY_JSON}
 * Outgoing: Backend REST API (http://localhost:8765/v1/*) --- {json | text, http_response}
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
   * Make HTTP request
   * @param {string} method - HTTP method
   * @param {string} url - Request URL
   * @param {Object} options - Request options
   * @returns {Promise<any>}
   */
  async request(method, url, options = {}) {
    // Check rate limiter
    if (this.rateLimiter) {
      const endpoint = this._getEndpointKey(method, url);
      const category = options.rateCategory || 'api';
      
      try {
        this.rateLimiter.check(endpoint, { category });
      } catch (error) {
        if (error.isRateLimitError) {
          if (this.enableLogging) {
            console.warn(`[ApiClient] Rate limited: ${method} ${url} (retry after ${error.retryAfter}ms)`);
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

    // Build full URL
    const fullURL = url.startsWith('http') ? url : `${this.baseURL}${url}`;

    // Build request config
    let config = {
      method: method.toUpperCase(),
      url: fullURL,
      headers: options.headers || {},
      body: options.body,
      timeout: options.timeout || this.timeout,
      signal: options.signal
    };

    // Run request interceptors
    for (const interceptor of this.requestInterceptors) {
      config = interceptor(config) || config;
    }

    // Retry logic
    let lastError;
    const maxAttempts = (options.retries !== undefined ? options.retries : this.retries) + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt > 0 && this.enableLogging) {
          console.log(`[ApiClient] Retry attempt ${attempt} for ${config.method} ${config.url}`);
        }

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
        if (error.isTimeoutError && attempt < maxAttempts - 1) {
          // Retry timeouts
          await this._delay(this.retryDelay * Math.pow(2, attempt));
          continue;
        }

        if (error.isApiError) {
          // Retry specific status codes
          if (this.retryStatusCodes.includes(error.status) && attempt < maxAttempts - 1) {
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
        if (attempt < maxAttempts - 1) {
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
    return this.request('GET', url, options);
  }

  /**
   * POST request
   */
  async post(url, body, options = {}) {
    return this.request('POST', url, { ...options, body });
  }

  /**
   * PUT request
   */
  async put(url, body, options = {}) {
    return this.request('PUT', url, { ...options, body });
  }

  /**
   * PATCH request
   */
  async patch(url, body, options = {}) {
    return this.request('PATCH', url, { ...options, body });
  }

  /**
   * DELETE request
   */
  async delete(url, options = {}) {
    return this.request('DELETE', url, options);
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
   * Get endpoint key for rate limiting
   * @param {string} method - HTTP method
   * @param {string} url - URL
   * @returns {string}
   * @private
   */
  _getEndpointKey(method, url) {
    // Extract path from full URL
    try {
      const parsed = new URL(url, this.baseURL || 'http://localhost');
      return `${method}:${parsed.pathname}`;
    } catch {
      return `${method}:${url}`;
    }
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
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    try {
      const fetchOptions = {
        method: config.method,
        headers: config.headers,
        signal: config.signal || controller.signal
      };

      if (config.body) {
        if (typeof config.body === 'object' && !(config.body instanceof FormData)) {
          fetchOptions.headers['Content-Type'] = 'application/json';
          fetchOptions.body = JSON.stringify(config.body);
        } else {
          fetchOptions.body = config.body;
        }
      }

      const response = await fetch(config.url, fetchOptions);

      clearTimeout(timeoutId);

      // Parse response
      const contentType = response.headers.get('Content-Type') || '';
      let data;

      if (contentType.includes('application/json')) {
        try {
          data = await response.json();
        } catch {
          data = await response.text();
        }
      } else {
        data = await response.text();
      }

      // Check status
      if (!response.ok) {
        throw new ApiError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          data,
          config.url
        );
      }

      return data;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new TimeoutError(`Request timeout after ${config.timeout}ms`, config.url);
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
module.exports = { ApiClient, ApiError, TimeoutError, CircuitBreakerError, CircuitBreaker };

if (typeof window !== 'undefined') {
  window.ApiClient = ApiClient;
  window.ApiError = ApiError;
  window.TimeoutError = TimeoutError;
  window.CircuitBreakerError = CircuitBreakerError;
  console.log('📦 ApiClient loaded');
}

