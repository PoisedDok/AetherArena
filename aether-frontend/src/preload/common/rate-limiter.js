'use strict';

/**
 * @.architecture
 * 
 * Incoming: bridge-factory (createBridge → rateLimiter.check), IPC channel calls --- {channel_name, string}
 * Processing: Token bucket algorithm per channel category (high/normal/low), refill tokens based on elapsed time, check available tokens before consuming, track statistics per channel (totalCalls/rateLimited/byChannel), validate rate limits, clear state --- {4 jobs: JOB_CLEAR_STATE, JOB_GET_STATE, JOB_INITIALIZE, JOB_UPDATE_STATE}
 * Outgoing: Boolean (allowed/denied), stats object --- {boolean | stats_object, boolean | javascript_object}
 * 
 * 
 * @module preload/common/rate-limiter
 * 
 * Rate Limiter
 * ============================================================================
 * Prevents IPC flooding by limiting calls per time window.
 * Token bucket algorithm with per-channel limits.
 * 
 * Security:
 * - Prevents renderer DoS attacks on main process
 * - Per-channel rate limits
 * - Configurable burst allowance
 * 
 * @module preload/common/rate-limiter
 */

const { freeze } = Object;

/**
 * Default rate limits per channel category
 */
const DEFAULT_LIMITS = freeze({
  // High-frequency channels (streaming, events)
  high: freeze({
    tokensPerInterval: 100,
    interval: 1000, // 1 second
    burst: 150,
  }),
  
  // Normal channels (user actions, state updates)
  normal: freeze({
    tokensPerInterval: 20,
    interval: 1000,
    burst: 30,
  }),
  
  // Low-frequency channels (file operations, window control)
  low: freeze({
    tokensPerInterval: 5,
    interval: 1000,
    burst: 10,
  }),
});

/**
 * Channel category assignments
 */
const CHANNEL_CATEGORIES = freeze({
  // High-frequency channels
  'chat:assistant-stream': 'high',
  'artifacts:stream': 'high',
  'wheel-event': 'high',
  'widget-position-update': 'high',
  
  // Normal channels
  'chat:send': 'normal',
  'chat:stop': 'normal',
  'chat:scroll-to-message': 'normal',
  'artifacts:focus-artifacts': 'normal',
  'artifacts:switch-tab': 'normal',
  'artifacts:load-code': 'normal',
  'artifacts:load-output': 'normal',
  'renderer-log': 'normal',
  
  // Low-frequency channels
  'chat:window-control': 'low',
  'artifacts:window-control': 'low',
  'artifacts:file-export': 'low',
  'artifacts:open-file': 'low',
  'toggle-widget-mode': 'low',
  'zoom-in': 'low',
  'zoom-out': 'low',
});

/**
 * Token bucket for a single channel
 */
class TokenBucket {
  constructor(config) {
    this.tokensPerInterval = config.tokensPerInterval;
    this.interval = config.interval;
    this.burst = config.burst;
    this.tokens = config.burst; // Start with full burst capacity
    this.lastRefill = Date.now();
  }
  
  /**
   * Refill tokens based on elapsed time
   */
  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    
    if (elapsed >= this.interval) {
      const intervals = Math.floor(elapsed / this.interval);
      const tokensToAdd = intervals * this.tokensPerInterval;
      this.tokens = Math.min(this.burst, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }
  
  /**
   * Try to consume a token
   * @param {number} cost - Number of tokens to consume (default: 1)
   * @returns {boolean} - True if token was consumed, false if rate limited
   */
  tryConsume(cost = 1) {
    this.refill();
    
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    
    return false;
  }
  
  /**
   * Get current token count
   * @returns {number}
   */
  getTokens() {
    this.refill();
    return this.tokens;
  }
}

/**
 * Rate limiter managing multiple channels
 */
class RateLimiter {
  constructor(options = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.categories = { ...CHANNEL_CATEGORIES, ...options.categories };
    this.buckets = new Map();
    this.enabled = options.enabled !== false;
    this.onRateLimited = options.onRateLimited || null;
    
    // Statistics
    this.stats = {
      totalCalls: 0,
      rateLimited: 0,
      byChannel: new Map(),
    };
  }
  
  /**
   * Get or create bucket for channel
   * @param {string} channel - Channel name
   * @returns {TokenBucket}
   * @private
   */
  getBucket(channel) {
    if (!this.buckets.has(channel)) {
      const category = this.categories[channel] || 'normal';
      const limit = this.limits[category] || this.limits.normal;
      this.buckets.set(channel, new TokenBucket(limit));
    }
    return this.buckets.get(channel);
  }
  
  /**
   * Update channel stats
   * @param {string} channel - Channel name
   * @param {boolean} allowed - Whether call was allowed
   * @private
   */
  updateStats(channel, allowed) {
    this.stats.totalCalls++;
    
    if (!this.stats.byChannel.has(channel)) {
      this.stats.byChannel.set(channel, { total: 0, limited: 0 });
    }
    
    const channelStats = this.stats.byChannel.get(channel);
    channelStats.total++;
    
    if (!allowed) {
      this.stats.rateLimited++;
      channelStats.limited++;
    }
  }
  
  /**
   * Check if call is allowed (consumes token)
   * @param {string} channel - Channel name
   * @param {number} cost - Token cost (default: 1)
   * @returns {boolean} - True if allowed, false if rate limited
   */
  check(channel, cost = 1) {
    if (!this.enabled) {
      return true;
    }
    
    const bucket = this.getBucket(channel);
    const allowed = bucket.tryConsume(cost);
    
    this.updateStats(channel, allowed);
    
    if (!allowed && this.onRateLimited) {
      this.onRateLimited(channel, {
        tokens: bucket.getTokens(),
        burst: bucket.burst,
      });
    }
    
    return allowed;
  }
  
  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      totalCalls: this.stats.totalCalls,
      rateLimited: this.stats.rateLimited,
      rateLimitedPercent: this.stats.totalCalls > 0 
        ? (this.stats.rateLimited / this.stats.totalCalls * 100).toFixed(2) 
        : 0,
      byChannel: Object.fromEntries(
        Array.from(this.stats.byChannel.entries()).map(([channel, stats]) => [
          channel,
          {
            ...stats,
            limitedPercent: stats.total > 0 
              ? (stats.limited / stats.total * 100).toFixed(2) 
              : 0,
          },
        ])
      ),
    };
  }
  
  /**
   * Get current token count for channel
   * @param {string} channel - Channel name
   * @returns {number}
   */
  getTokens(channel) {
    const bucket = this.getBucket(channel);
    return bucket.getTokens();
  }
  
  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalCalls: 0,
      rateLimited: 0,
      byChannel: new Map(),
    };
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
   * Clear all buckets
   */
  clear() {
    this.buckets.clear();
  }
}

/**
 * Create rate limiter instance
 * @param {Object} options - Configuration options
 * @returns {RateLimiter}
 */
function createRateLimiter(options = {}) {
  return new RateLimiter(options);
}

module.exports = {
  RateLimiter,
  TokenBucket,
  createRateLimiter,
  DEFAULT_LIMITS,
  CHANNEL_CATEGORIES,
};

