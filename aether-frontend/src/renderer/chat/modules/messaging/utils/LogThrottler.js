'use strict';

/**
 * @.architecture
 *
 * Incoming: Log requests with throttling config --- {log_request, object}
 * Processing: Track last log time, throttle by interval --- {1 job: JOB_THROTTLE_LOGS}
 * Outgoing: Boolean decision (should log or skip) --- {boolean, primitive}
 *
 * @module renderer/chat/modules/messaging/utils/LogThrottler
 */

/**
 * LogThrottler - Throttled Logging Utility
 * =========================================
 * 
 * SINGLE RESPONSIBILITY: Throttle high-frequency log messages
 * 
 * USE CASE:
 * Artifact/message streaming generates hundreds of log calls per second.
 * This utility prevents log spam by throttling to configurable intervals.
 * 
 * CONTRACTS:
 * - NO business logic
 * - Pure throttling logic
 * - Stateless per-instance basis
 * 
 * @module renderer/chat/modules/messaging/utils/LogThrottler
 */
class LogThrottler {
  /**
   * @param {Object} options - Configuration
   * @param {number} options.interval - Minimum ms between logs (default 1000)
   */
  constructor(options = {}) {
    this.interval = options.interval ?? 1000;
    this.lastLog = 0;
    this.updateCount = 0;
    this.currentKey = null;
  }

  /**
   * Check if should log (and record if yes)
   * @param {string} key - Optional key for tracking separate throttle streams
   * @returns {boolean} True if should log
   */
  shouldLog(key = null) {
    const now = Date.now();

    // Track update count
    if (key && this.currentKey !== key) {
      this.currentKey = key;
      this.updateCount = 0;
    }
    this.updateCount++;

    // Check if enough time has passed
    if (now - this.lastLog >= this.interval) {
      this.lastLog = now;
      const count = this.updateCount;
      this.updateCount = 0;
      return { log: true, count };
    }

    return { log: false, count: this.updateCount };
  }

  /**
   * Force next log (ignore throttle)
   */
  force() {
    this.lastLog = 0;
  }

  /**
   * Reset throttler state
   */
  reset() {
    this.lastLog = 0;
    this.updateCount = 0;
    this.currentKey = null;
  }

  /**
   * Get update count since last log
   * @returns {number}
   */
  getUpdateCount() {
    return this.updateCount;
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LogThrottler;
}

if (typeof window !== 'undefined') {
  window.LogThrottler = LogThrottler;
}
