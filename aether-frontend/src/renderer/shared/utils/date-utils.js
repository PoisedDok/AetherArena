'use strict';

/**
 * @.architecture
 *
 * Incoming: All modules (date formatting calls) --- {date_types.*, Date | string | number}
 * Processing: Date formatting, relative time calculation, duration formatting, timestamp conversions --- {2 jobs: JOB_GET_STATE, JOB_UPDATE_STATE}
 * Outgoing: Return formatted date strings --- {date_types.formatted, string}
 *
 * @module renderer/shared/utils/date-utils
 */

/**
 * DateUtils - Date Formatting and Manipulation Utilities
 * ============================================================================
 * Production-ready date utility functions with:
 * - Multiple format options
 * - Relative time formatting (e.g., "2 hours ago")
 * - ISO 8601 support
 * - Timestamp conversion
 * - Duration formatting
 * - Timezone handling
 * 
 * Responsibilities:
 * - Format dates for display
 * - Convert between date formats
 * - Calculate relative times
 * - Handle timezones
 * - Parse date strings
 * 
 * Architecture:
 * - Pure utility functions
 * - No external dependencies
 * - Framework-agnostic
 * - Production-ready error handling
 * 
 * @module renderer/shared/utils/date-utils
 */

const { freeze } = Object;

// Configuration
const CONFIG = freeze({
  MILLISECONDS_PER_SECOND: 1000,
  SECONDS_PER_MINUTE: 60,
  MINUTES_PER_HOUR: 60,
  HOURS_PER_DAY: 24,
  DAYS_PER_WEEK: 7,
  DAYS_PER_MONTH: 30,
  DAYS_PER_YEAR: 365,
});

/**
 * Date Utility Functions
 */
const DateUtils = freeze({
  /**
   * Format date to localized string
   * @param {Date|string|number} date - Date to format
   * @param {Object} options - Intl.DateTimeFormat options
   * @returns {string} Formatted date string
   */
  format(date, options = {}) {
    try {
      const d = this._parseDate(date);
      if (!d) return '';

      const defaultOptions = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      };

      return d.toLocaleDateString(undefined, { ...defaultOptions, ...options });
    } catch (error) {
      console.error('[DateUtils] format failed:', error);
      return '';
    }
  },

  /**
   * Format time to localized string
   * @param {Date|string|number} date - Date to format
   * @param {Object} options - Intl.DateTimeFormat options
   * @returns {string} Formatted time string
   */
  formatTime(date, options = {}) {
    try {
      const d = this._parseDate(date);
      if (!d) return '';

      const defaultOptions = {
        hour: '2-digit',
        minute: '2-digit',
      };

      return d.toLocaleTimeString(undefined, { ...defaultOptions, ...options });
    } catch (error) {
      console.error('[DateUtils] formatTime failed:', error);
      return '';
    }
  },

  /**
   * Format datetime to localized string
   * @param {Date|string|number} date - Date to format
   * @param {Object} options - Intl.DateTimeFormat options
   * @returns {string} Formatted datetime string
   */
  formatDateTime(date, options = {}) {
    try {
      const d = this._parseDate(date);
      if (!d) return '';

      const defaultOptions = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      };

      return d.toLocaleString(undefined, { ...defaultOptions, ...options });
    } catch (error) {
      console.error('[DateUtils] formatDateTime failed:', error);
      return '';
    }
  },

  /**
   * Format date to ISO 8601 string
   * @param {Date|string|number} date - Date to format
   * @returns {string} ISO 8601 string
   */
  toISO(date) {
    try {
      const d = this._parseDate(date);
      return d ? d.toISOString() : '';
    } catch (error) {
      console.error('[DateUtils] toISO failed:', error);
      return '';
    }
  },

  /**
   * Format date as relative time (e.g., "2 hours ago")
   * @param {Date|string|number} date - Date to format
   * @returns {string} Relative time string
   */
  relative(date) {
    try {
      const d = this._parseDate(date);
      if (!d) return '';

      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffSec = Math.floor(diffMs / CONFIG.MILLISECONDS_PER_SECOND);

      // Future dates
      if (diffSec < 0) {
        const absDiff = Math.abs(diffSec);
        if (absDiff < CONFIG.SECONDS_PER_MINUTE) return 'in a few seconds';
        if (absDiff < CONFIG.SECONDS_PER_MINUTE * 2) return 'in 1 minute';
        if (absDiff < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR) {
          return `in ${Math.floor(absDiff / CONFIG.SECONDS_PER_MINUTE)} minutes`;
        }
        if (absDiff < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * 2) return 'in 1 hour';
        if (absDiff < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY) {
          return `in ${Math.floor(absDiff / (CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR))} hours`;
        }
        return this.format(d);
      }

      // Past dates
      if (diffSec < 10) return 'just now';
      if (diffSec < CONFIG.SECONDS_PER_MINUTE) return `${diffSec} seconds ago`;
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * 2) return '1 minute ago';
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR) {
        return `${Math.floor(diffSec / CONFIG.SECONDS_PER_MINUTE)} minutes ago`;
      }
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * 2) return '1 hour ago';
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY) {
        return `${Math.floor(diffSec / (CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR))} hours ago`;
      }
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * 2) return 'yesterday';
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * CONFIG.DAYS_PER_WEEK) {
        return `${Math.floor(diffSec / (CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY))} days ago`;
      }
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * CONFIG.DAYS_PER_WEEK * 2) return '1 week ago';
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * CONFIG.DAYS_PER_MONTH) {
        return `${Math.floor(diffSec / (CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * CONFIG.DAYS_PER_WEEK))} weeks ago`;
      }
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * CONFIG.DAYS_PER_MONTH * 2) return '1 month ago';
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * CONFIG.DAYS_PER_YEAR) {
        return `${Math.floor(diffSec / (CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * CONFIG.DAYS_PER_MONTH))} months ago`;
      }
      if (diffSec < CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * CONFIG.DAYS_PER_YEAR * 2) return '1 year ago';
      return `${Math.floor(diffSec / (CONFIG.SECONDS_PER_MINUTE * CONFIG.MINUTES_PER_HOUR * CONFIG.HOURS_PER_DAY * CONFIG.DAYS_PER_YEAR))} years ago`;

    } catch (error) {
      console.error('[DateUtils] relative failed:', error);
      return '';
    }
  },

  /**
   * Format duration in milliseconds to human-readable string
   * @param {number} ms - Duration in milliseconds
   * @param {boolean} verbose - Use verbose format (default: false)
   * @returns {string} Formatted duration
   */
  formatDuration(ms, verbose = false) {
    try {
      if (ms < 0) return '0ms';
      if (ms < 1000) return `${Math.floor(ms)}ms`;

      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (verbose) {
        const parts = [];
        if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
        if (hours % 24 > 0) parts.push(`${hours % 24} hour${hours % 24 > 1 ? 's' : ''}`);
        if (minutes % 60 > 0) parts.push(`${minutes % 60} minute${minutes % 60 > 1 ? 's' : ''}`);
        if (seconds % 60 > 0) parts.push(`${seconds % 60} second${seconds % 60 > 1 ? 's' : ''}`);
        return parts.join(', ');
      } else {
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
      }
    } catch (error) {
      console.error('[DateUtils] formatDuration failed:', error);
      return '0ms';
    }
  },

  /**
   * Get timestamp in milliseconds
   * @param {Date|string|number} date - Date (default: now)
   * @returns {number} Timestamp in ms
   */
  getTimestamp(date = null) {
    try {
      if (date === null) return Date.now();
      const d = this._parseDate(date);
      return d ? d.getTime() : Date.now();
    } catch (error) {
      console.error('[DateUtils] getTimestamp failed:', error);
      return Date.now();
    }
  },

  /**
   * Get timestamp in seconds
   * @param {Date|string|number} date - Date (default: now)
   * @returns {number} Timestamp in seconds
   */
  getTimestampSeconds(date = null) {
    return Math.floor(this.getTimestamp(date) / 1000);
  },

  /**
   * Check if date is today
   * @param {Date|string|number} date - Date to check
   * @returns {boolean}
   */
  isToday(date) {
    try {
      const d = this._parseDate(date);
      if (!d) return false;

      const today = new Date();
      return (
        d.getDate() === today.getDate() &&
        d.getMonth() === today.getMonth() &&
        d.getFullYear() === today.getFullYear()
      );
    } catch (error) {
      return false;
    }
  },

  /**
   * Check if date is yesterday
   * @param {Date|string|number} date - Date to check
   * @returns {boolean}
   */
  isYesterday(date) {
    try {
      const d = this._parseDate(date);
      if (!d) return false;

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      return (
        d.getDate() === yesterday.getDate() &&
        d.getMonth() === yesterday.getMonth() &&
        d.getFullYear() === yesterday.getFullYear()
      );
    } catch (error) {
      return false;
    }
  },

  /**
   * Check if date is in the past
   * @param {Date|string|number} date - Date to check
   * @returns {boolean}
   */
  isPast(date) {
    try {
      const d = this._parseDate(date);
      return d ? d.getTime() < Date.now() : false;
    } catch (error) {
      return false;
    }
  },

  /**
   * Check if date is in the future
   * @param {Date|string|number} date - Date to check
   * @returns {boolean}
   */
  isFuture(date) {
    try {
      const d = this._parseDate(date);
      return d ? d.getTime() > Date.now() : false;
    } catch (error) {
      return false;
    }
  },

  /**
   * Add time to date
   * @param {Date|string|number} date - Base date
   * @param {number} amount - Amount to add
   * @param {string} unit - Unit (ms, s, m, h, d, w, M, y)
   * @returns {Date} New date
   */
  add(date, amount, unit = 'ms') {
    try {
      const d = this._parseDate(date);
      if (!d) return new Date();

      const result = new Date(d);
      const multipliers = {
        ms: 1,
        s: 1000,
        m: 1000 * 60,
        h: 1000 * 60 * 60,
        d: 1000 * 60 * 60 * 24,
        w: 1000 * 60 * 60 * 24 * 7,
        M: 1000 * 60 * 60 * 24 * 30,
        y: 1000 * 60 * 60 * 24 * 365,
      };

      const multiplier = multipliers[unit] || 1;
      result.setTime(result.getTime() + amount * multiplier);

      return result;
    } catch (error) {
      console.error('[DateUtils] add failed:', error);
      return new Date();
    }
  },

  /**
   * Parse date from multiple formats
   * @private
   * @param {Date|string|number} date - Date to parse
   * @returns {Date|null}
   */
  _parseDate(date) {
    if (!date) return null;

    try {
      if (date instanceof Date) {
        return isNaN(date.getTime()) ? null : date;
      }

      if (typeof date === 'number') {
        return new Date(date);
      }

      if (typeof date === 'string') {
        // ISO 8601 format
        if (date.includes('T') || date.includes('-')) {
          const d = new Date(date);
          return isNaN(d.getTime()) ? null : d;
        }

        // Unix timestamp (as string)
        const timestamp = parseInt(date, 10);
        if (!isNaN(timestamp)) {
          return new Date(timestamp);
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  },
});

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DateUtils;
}

if (typeof window !== 'undefined') {
  window.DateUtils = DateUtils;
  console.log('📦 DateUtils loaded');
}

