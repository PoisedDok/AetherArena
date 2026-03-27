'use strict';

/**
 * @.architecture
 *
 * Incoming: Timestamp values (ISO string, epoch ms, Date object) --- {timestamp, string|number|Date}
 * Processing: Parse and format timestamps to locale time strings --- {1 job: JOB_FORMAT_TIME}
 * Outgoing: Formatted time strings --- {formatted_time, string}
 *
 * @module renderer/chat/modules/messaging/utils/TimeFormatter
 */

/**
 * TimeFormatter - Pure Timestamp Formatting Utility
 * ==================================================
 * 
 * SINGLE RESPONSIBILITY: Format timestamps for display
 * 
 * CONTRACTS:
 * - NO business logic
 * - Pure functions only
 * - Graceful fallback to current time on error
 * 
 * @module renderer/chat/modules/messaging/utils/TimeFormatter
 */
class TimeFormatter {
  /**
   * Format timestamp to locale time string
   * @param {string|number|Date} timestamp - ISO timestamp, epoch ms, or Date object
   * @returns {string} Formatted time (e.g., "2:45:30 PM")
   */
  static format(timestamp) {
    try {
      if (!timestamp) {
        return new Date().toLocaleTimeString();
      }

      // ISO string (contains 'T')
      if (typeof timestamp === 'string' && timestamp.includes('T')) {
        const date = new Date(timestamp);
        if (!isNaN(date.getTime())) {
          return date.toLocaleTimeString();
        }
      }

      // Epoch milliseconds (number)
      if (typeof timestamp === 'number') {
        const date = new Date(timestamp);
        if (!isNaN(date.getTime())) {
          return date.toLocaleTimeString();
        }
      }

      // Date object
      if (timestamp instanceof Date) {
        if (!isNaN(timestamp.getTime())) {
          return timestamp.toLocaleTimeString();
        }
      }

      // Fallback
      return new Date().toLocaleTimeString();
    } catch (error) {
      // Graceful fallback
      return new Date().toLocaleTimeString();
    }
  }

  /**
   * Format timestamp to short time (no seconds)
   * @param {string|number|Date} timestamp - Timestamp
   * @returns {string} Short time (e.g., "2:45 PM")
   */
  static formatShort(timestamp) {
    try {
      const date = TimeFormatter._parseTimestamp(timestamp);
      if (!date) {
        return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (error) {
      return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  }

  /**
   * Parse timestamp to Date object
   * @private
   * @param {string|number|Date} timestamp - Timestamp
   * @returns {Date|null}
   */
  static _parseTimestamp(timestamp) {
    if (!timestamp) return null;

    if (timestamp instanceof Date) {
      return isNaN(timestamp.getTime()) ? null : timestamp;
    }

    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? null : date;
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TimeFormatter;
}

if (typeof window !== 'undefined') {
  window.TimeFormatter = TimeFormatter;
}
