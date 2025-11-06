'use strict';

/**
 * @.architecture
 * 
 * Incoming: bridge-factory (createBridge → sizeValidator.validate), IPC payloads --- {method_call, any}
 * Processing: Validate payload size limits per channel, check object nesting depth, check array length, check string length, calculate approximate byte size, track violation statistics, clear stats --- {3 jobs: JOB_CLEAR_STATE, JOB_GET_STATE, JOB_UPDATE_STATE}
 * Outgoing: Validation result {valid, error, size} --- {validation_result, javascript_object}
 * 
 * @module preload/common/size-validator
 * 
 * Size Validator
 * ============================================================================
 * Validates payload sizes to prevent memory exhaustion and DoS attacks.
 * Enforces per-channel size limits on IPC messages.
 * 
 * Security:
 * - Prevents large payloads from crashing main process
 * - Per-channel size limits
 * - Nested object depth limits
 * 
 * @module preload/common/size-validator
 */

const { freeze } = Object;

/**
 * Default size limits (in bytes)
 */
const DEFAULT_SIZE_LIMITS = freeze({
  // String length limits
  maxStringLength: 10 * 1024 * 1024, // 10MB (for large artifacts)
  maxArrayLength: 10000, // Max array elements
  maxObjectDepth: 10, // Max nesting depth
  
  // Per-channel limits
  channels: freeze({
    // Large content channels
    'artifacts:stream': 5 * 1024 * 1024, // 5MB
    'artifacts:load-code': 5 * 1024 * 1024, // 5MB
    'artifacts:load-output': 5 * 1024 * 1024, // 5MB
    'artifacts:file-export': 10 * 1024 * 1024, // 10MB
    'chat:send': 100 * 1024, // 100KB
    
    // Normal channels
    'chat:assistant-stream': 10 * 1024, // 10KB per chunk
    'widget-position-update': 1024, // 1KB
    'renderer-log': 10 * 1024, // 10KB
    
    // Control channels
    'chat:window-control': 1024, // 1KB
    'artifacts:window-control': 1024, // 1KB
    'chat:stop': 1024, // 1KB
    'zoom-in': 1024, // 1KB
    'zoom-out': 1024, // 1KB
    'toggle-widget-mode': 1024, // 1KB
  }),
});

/**
 * Calculate size of value in bytes (approximate)
 * @param {any} value - Value to measure
 * @returns {number} - Approximate size in bytes
 * @private
 */
function calculateSize(value) {
  if (value === null || value === undefined) {
    return 0;
  }
  
  const type = typeof value;
  
  switch (type) {
    case 'boolean':
      return 4;
    case 'number':
      return 8;
    case 'string':
      return value.length * 2; // UTF-16 encoding
    case 'object':
      if (Array.isArray(value)) {
        return value.reduce((sum, item) => sum + calculateSize(item), 0);
      }
      return Object.keys(value).reduce(
        (sum, key) => sum + key.length * 2 + calculateSize(value[key]),
        0
      );
    default:
      return 0;
  }
}

/**
 * Check object nesting depth
 * @param {any} value - Value to check
 * @param {number} currentDepth - Current depth
 * @param {number} maxDepth - Maximum allowed depth
 * @returns {boolean} - True if within limits
 * @private
 */
function checkDepth(value, currentDepth = 0, maxDepth = 10) {
  if (currentDepth > maxDepth) {
    return false;
  }
  
  if (value === null || value === undefined) {
    return true;
  }
  
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.every(item => checkDepth(item, currentDepth + 1, maxDepth));
    }
    return Object.values(value).every(val => checkDepth(val, currentDepth + 1, maxDepth));
  }
  
  return true;
}

/**
 * Size validator
 */
class SizeValidator {
  constructor(options = {}) {
    this.maxStringLength = options.maxStringLength || DEFAULT_SIZE_LIMITS.maxStringLength;
    this.maxArrayLength = options.maxArrayLength || DEFAULT_SIZE_LIMITS.maxArrayLength;
    this.maxObjectDepth = options.maxObjectDepth || DEFAULT_SIZE_LIMITS.maxObjectDepth;
    this.channelLimits = { ...DEFAULT_SIZE_LIMITS.channels, ...options.channelLimits };
    this.enabled = options.enabled !== false;
    this.onViolation = options.onViolation || null;
    
    // Statistics
    this.stats = {
      totalChecks: 0,
      violations: 0,
      byChannel: new Map(),
    };
  }
  
  /**
   * Update stats
   * @param {string} channel - Channel name
   * @param {boolean} valid - Whether validation passed
   * @param {string} reason - Violation reason if failed
   * @private
   */
  updateStats(channel, valid, reason = null) {
    this.stats.totalChecks++;
    
    if (!this.stats.byChannel.has(channel)) {
      this.stats.byChannel.set(channel, {
        checks: 0,
        violations: 0,
        reasons: {},
      });
    }
    
    const channelStats = this.stats.byChannel.get(channel);
    channelStats.checks++;
    
    if (!valid) {
      this.stats.violations++;
      channelStats.violations++;
      
      if (reason) {
        channelStats.reasons[reason] = (channelStats.reasons[reason] || 0) + 1;
      }
    }
  }
  
  /**
   * Validate payload size
   * @param {string} channel - Channel name
   * @param {any} payload - Payload to validate
   * @returns {Object} - { valid: boolean, error?: string, size?: number }
   */
  validate(channel, payload) {
    if (!this.enabled) {
      return { valid: true };
    }
    
    // Check object depth
    if (!checkDepth(payload, 0, this.maxObjectDepth)) {
      const error = `Payload exceeds maximum nesting depth of ${this.maxObjectDepth}`;
      this.updateStats(channel, false, 'depth');
      
      if (this.onViolation) {
        this.onViolation(channel, error, { depth: this.maxObjectDepth });
      }
      
      return { valid: false, error };
    }
    
    // Check array length
    if (Array.isArray(payload) && payload.length > this.maxArrayLength) {
      const error = `Array length ${payload.length} exceeds maximum of ${this.maxArrayLength}`;
      this.updateStats(channel, false, 'array_length');
      
      if (this.onViolation) {
        this.onViolation(channel, error, { length: payload.length, max: this.maxArrayLength });
      }
      
      return { valid: false, error };
    }
    
    // Check string length
    if (typeof payload === 'string' && payload.length > this.maxStringLength) {
      const error = `String length ${payload.length} exceeds maximum of ${this.maxStringLength}`;
      this.updateStats(channel, false, 'string_length');
      
      if (this.onViolation) {
        this.onViolation(channel, error, { length: payload.length, max: this.maxStringLength });
      }
      
      return { valid: false, error };
    }
    
    // Calculate total size
    const size = calculateSize(payload);
    const channelLimit = this.channelLimits[channel];
    
    if (channelLimit && size > channelLimit) {
      const error = `Payload size ${size} bytes exceeds channel limit of ${channelLimit} bytes`;
      this.updateStats(channel, false, 'size');
      
      if (this.onViolation) {
        this.onViolation(channel, error, { size, limit: channelLimit });
      }
      
      return { valid: false, error, size };
    }
    
    this.updateStats(channel, true);
    return { valid: true, size };
  }
  
  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return {
      totalChecks: this.stats.totalChecks,
      violations: this.stats.violations,
      violationPercent: this.stats.totalChecks > 0
        ? (this.stats.violations / this.stats.totalChecks * 100).toFixed(2)
        : 0,
      byChannel: Object.fromEntries(
        Array.from(this.stats.byChannel.entries()).map(([channel, stats]) => [
          channel,
          {
            ...stats,
            violationPercent: stats.checks > 0
              ? (stats.violations / stats.checks * 100).toFixed(2)
              : 0,
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
      totalChecks: 0,
      violations: 0,
      byChannel: new Map(),
    };
  }
  
  /**
   * Enable validation
   */
  enable() {
    this.enabled = true;
  }
  
  /**
   * Disable validation
   */
  disable() {
    this.enabled = false;
  }
}

/**
 * Create size validator instance
 * @param {Object} options - Configuration options
 * @returns {SizeValidator}
 */
function createSizeValidator(options = {}) {
  return new SizeValidator(options);
}

module.exports = {
  SizeValidator,
  createSizeValidator,
  DEFAULT_SIZE_LIMITS,
  calculateSize,
};

