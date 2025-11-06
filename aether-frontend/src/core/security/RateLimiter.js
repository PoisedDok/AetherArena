'use strict';

/**
 * @.architecture
 * 
 * Incoming: ApiClient.request(), IpcBridge.send(), preload scripts (IPC rate checks) --- {request_types.*, method_call}
 * Processing: Token bucket algorithm - track per-endpoint tokens, refill at configurable rate, consume on each call, throw RateLimitError if insufficient tokens --- {3 jobs: JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA, JOB_TRACK_ENTITY}
 * Outgoing: Return allowed/retryAfter status or throw RateLimitError --- {rate_limit_types.result, {allowed: boolean, retryAfter: number}}
 * 
 * 
 * @module core/security/RateLimiter
 */

const { freeze } = Object;

/**
 * Default rate limit configurations by category
 */
const DEFAULT_LIMITS = freeze({
  // WebSocket streaming (high-frequency)
  streaming: freeze({
    tokensPerSecond: 100,
    burstCapacity: 150,
  }),
  
  // API requests (normal)
  api: freeze({
    tokensPerSecond: 20,
    burstCapacity: 30,
  }),
  
  // Heavy operations (file upload, etc.)
  heavy: freeze({
    tokensPerSecond: 5,
    burstCapacity: 10,
  }),
  
  // Window/UI controls (low)
  control: freeze({
    tokensPerSecond: 10,
    burstCapacity: 15,
  }),
});

/**
 * Token bucket implementation
 */
class TokenBucket {
  constructor(options = {}) {
    this.tokensPerSecond = options.tokensPerSecond || 20;
    this.burstCapacity = options.burstCapacity || 30;
    this.tokens = this.burstCapacity; // Start with full burst
    this.lastRefill = Date.now();
  }

  /**
   * Refill tokens based on elapsed time
   * @private
   */
  _refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    
    if (elapsedSeconds > 0) {
      const tokensToAdd = elapsedSeconds * this.tokensPerSecond;
      this.tokens = Math.min(this.burstCapacity, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  /**
   * Try to consume tokens
   * @param {number} cost - Number of tokens to consume
   * @returns {boolean} - True if tokens consumed, false if insufficient
   */
  tryConsume(cost = 1) {
    this._refill();
    
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    
    return false;
  }

  /**
   * Get time until next token available (in milliseconds)
   * @returns {number}
   */
  getRetryAfter() {
    this._refill();
    
    if (this.tokens >= 1) {
      return 0;
    }
    
    const tokensNeeded = 1 - this.tokens;
    return Math.ceil((tokensNeeded / this.tokensPerSecond) * 1000);
  }

  /**
   * Get current token count
   * @returns {number}
   */
  getTokens() {
    this._refill();
    return this.tokens;
  }

  /**
   * Get bucket info
   * @returns {Object}
   */
  getInfo() {
    this._refill();
    return freeze({
      tokens: this.tokens,
      capacity: this.burstCapacity,
      rate: this.tokensPerSecond,
      retryAfter: this.getRetryAfter(),
    });
  }
}

/**
 * Rate limiter error
 */
class RateLimitError extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
    this.isRateLimitError = true;
  }
}

/**
 * Rate limiter managing multiple endpoints
 */
class RateLimiter {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    
    // Support multiple constructor APIs for compatibility
    if (options.windowMs && options.maxRequests) {
      // windowMs/maxRequests API
      this.limits = {
        api: {
          tokensPerSecond: options.maxRequests / (options.windowMs / 1000),
          burstCapacity: options.maxRequests,
        },
      };
    } else if (options.window && options.maxCalls) {
      // window/maxCalls API  
      this.limits = {
        api: {
          tokensPerSecond: options.maxCalls / (options.window / 1000),
          burstCapacity: options.maxCalls,
        },
      };
    } else {
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    }
    
    this.buckets = new Map();
    
    // Statistics
    this.stats = {
      totalRequests: 0,
      rateLimited: 0,
      byEndpoint: new Map(),
    };
    
    // Callbacks
    this.onRateLimited = options.onRateLimited || null;
    this.onRequestAllowed = options.onRequestAllowed || null;
  }

  /**
   * Get or create bucket for endpoint
   * @param {string} endpoint - Endpoint identifier
   * @param {string} category - Rate limit category
   * @returns {TokenBucket}
   * @private
   */
  _getBucket(endpoint, category = 'api') {
    if (!this.buckets.has(endpoint)) {
      const limit = this.limits[category] || this.limits.api;
      this.buckets.set(endpoint, new TokenBucket(limit));
    }
    return this.buckets.get(endpoint);
  }

  /**
   * Update statistics
   * @param {string} endpoint - Endpoint identifier
   * @param {boolean} allowed - Whether request was allowed
   * @private
   */
  _updateStats(endpoint, allowed) {
    this.stats.totalRequests++;
    
    if (!this.stats.byEndpoint.has(endpoint)) {
      this.stats.byEndpoint.set(endpoint, {
        total: 0,
        limited: 0,
      });
    }
    
    const endpointStats = this.stats.byEndpoint.get(endpoint);
    endpointStats.total++;
    
    if (!allowed) {
      this.stats.rateLimited++;
      endpointStats.limited++;
    }
  }

  /**
   * Check rate limit (throws on limit exceeded)
   * @param {string} endpoint - Endpoint identifier
   * @param {Object} options - Options
   * @returns {void}
   * @throws {RateLimitError}
   */
  check(endpoint, options = {}) {
    if (!this.enabled) {
      return;
    }

    const category = options.category || 'api';
    const cost = options.cost || 1;
    
    const bucket = this._getBucket(endpoint, category);
    const allowed = bucket.tryConsume(cost);
    
    this._updateStats(endpoint, allowed);
    
    if (!allowed) {
      const retryAfter = bucket.getRetryAfter();
      
      if (this.onRateLimited) {
        this.onRateLimited(endpoint, {
          category,
          retryAfter,
          info: bucket.getInfo(),
        });
      }
      
      throw new RateLimitError(
        `Rate limit exceeded for ${endpoint}. Retry after ${retryAfter}ms`,
        retryAfter
      );
    }
    
    if (this.onRequestAllowed) {
      this.onRequestAllowed(endpoint, {
        category,
        info: bucket.getInfo(),
      });
    }
  }

  /**
   * Try to consume tokens without throwing
   * @param {string} endpoint - Endpoint identifier
   * @param {Object} options - Options
   * @returns {Object} - { allowed: boolean, retryAfter: number }
   */
  tryConsume(endpoint, options = {}) {
    if (!this.enabled) {
      return { allowed: true, retryAfter: 0 };
    }

    const category = options.category || 'api';
    const cost = options.cost || 1;
    
    const bucket = this._getBucket(endpoint, category);
    const allowed = bucket.tryConsume(cost);
    
    this._updateStats(endpoint, allowed);
    
    return {
      allowed,
      retryAfter: allowed ? 0 : bucket.getRetryAfter(),
      info: bucket.getInfo(),
    };
  }

  /**
   * Get bucket info for endpoint
   * @param {string} endpoint - Endpoint identifier
   * @param {string} category - Rate limit category
   * @returns {Object}
   */
  getInfo(endpoint, category = 'api') {
    const bucket = this._getBucket(endpoint, category);
    return bucket.getInfo();
  }

  /**
   * Get statistics
   * @param {string} [key] - Optional key to get stats for specific endpoint
   * @returns {Object}
   */
  getStats(key = null) {
    // If key provided, return endpoint-specific stats
    if (key !== null) {
      const bucket = this._getBucket(key);
      const endpointStats = this.stats.byEndpoint.get(key) || { total: 0, limited: 0 };
      return {
        count: endpointStats.total,
        remaining: Math.max(0, Math.floor(bucket.getTokens())),
        total: endpointStats.total,
        limited: endpointStats.limited,
      };
    }
    
    // Otherwise return global stats
    return {
      totalRequests: this.stats.totalRequests,
      rateLimited: this.stats.rateLimited,
      rateLimitRate: this.stats.totalRequests > 0
        ? (this.stats.rateLimited / this.stats.totalRequests * 100).toFixed(2) + '%'
        : '0%',
      byEndpoint: Object.fromEntries(
        Array.from(this.stats.byEndpoint.entries()).map(([endpoint, stats]) => [
          endpoint,
          {
            ...stats,
            limitRate: stats.total > 0
              ? (stats.limited / stats.total * 100).toFixed(2) + '%'
              : '0%',
          },
        ])
      ),
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      rateLimited: 0,
      byEndpoint: new Map(),
    };
  }

  /**
   * Clear all buckets
   */
  clear() {
    this.buckets.clear();
  }

  /**
   * Enable rate limiting
   */
  enable() {
    this.enabled = true;
  }

  /**
   * Disable rate limiting
   */
  disable() {
    this.enabled = false;
  }

  /**
   * Check if rate limiting is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled;
  }

  // ============================================================================
  // Compatibility Methods (for tests)
  // ============================================================================

  /**
   * Try to acquire token (alias for tryConsume)
   * @param {string} key - Key identifier
   * @returns {boolean}
   */
  tryAcquire(key) {
    const result = this.tryConsume(key);
    return result.allowed;
  }

  /**
   * Check limit (alias for check, but returns boolean)
   * @param {string} key - Key identifier
   * @returns {boolean}
   */
  checkLimit(key) {
    if (!this.enabled) {
      return true;
    }
    try {
      this.check(key);
      return true;
    } catch (error) {
      if (error.isRateLimitError) {
        return false;
      }
      throw error;
    }
  }
}

// Export
module.exports = {
  RateLimiter,
  TokenBucket,
  RateLimitError,
  DEFAULT_LIMITS,
};

if (typeof window !== 'undefined') {
  window.RateLimiter = RateLimiter;
  window.RateLimitError = RateLimitError;
  console.log('📦 RateLimiter loaded');
}

