'use strict';

/**
 * @.architecture
 *
 * Incoming: All modules (formatting calls for display) --- {format_types.*, any}
 * Processing: Data formatting - fileSize (bytes→KB/MB/GB with 1024 base), number (→K/M/B/T with 1000 base), percentage (0-1 or 0-100), currency (Intl.NumberFormat), truncate (end/middle ellipsis), pluralize (singular/plural forms), boolean (Yes/No), phone (US format), JSON (stringify with indent), latency/FPS/memory/CPU for technical metrics, case conversions (camelCase/kebab-case/titleCase), list formatting (commas + 'and') --- {15+ jobs: JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_PARSE_JSON, JOB_UPDATE_STATE}
 * Outgoing: Return formatted strings --- {string, string}
 *
 *
 * @module renderer/shared/utils/format-utils
 */

/**
 * FormatUtils - Data Formatting Utilities
 * ============================================================================
 * Production-ready formatting utility functions with:
 * - File size formatting (bytes to human-readable)
 * - Number formatting (K, M, B suffixes)
 * - Percentage formatting
 * - Currency formatting
 * - Text truncation and ellipsis
 * - Pluralization helpers
 * 
 * Responsibilities:
 * - Format file sizes
 * - Format large numbers
 * - Format percentages and currency
 * - Truncate text with ellipsis
 * - Handle pluralization
 * - Format technical units
 * 
 * Architecture:
 * - Pure utility functions
 * - No external dependencies
 * - Framework-agnostic
 * - Production-ready error handling
 * 
 * @module renderer/shared/utils/format-utils
 */

const { freeze } = Object;

// Configuration
const CONFIG = freeze({
  FILE_SIZE_UNITS: freeze(['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB']),
  FILE_SIZE_BASE: 1024,
  NUMBER_SUFFIXES: freeze(['', 'K', 'M', 'B', 'T']),
  NUMBER_BASE: 1000,
  DEFAULT_DECIMAL_PLACES: 2,
});

/**
 * Format Utility Functions
 */
const FormatUtils = freeze({
  /**
   * Format file size in bytes to human-readable string
   * @param {number} bytes - File size in bytes
   * @param {number} decimals - Decimal places (default: 2)
   * @returns {string} Formatted file size
   */
  fileSize(bytes, decimals = CONFIG.DEFAULT_DECIMAL_PLACES) {
    try {
      if (bytes === 0) return '0 Bytes';
      if (bytes < 0) return 'Invalid size';

      const k = CONFIG.FILE_SIZE_BASE;
      const dm = decimals < 0 ? 0 : decimals;
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      const index = Math.min(i, CONFIG.FILE_SIZE_UNITS.length - 1);

      const value = bytes / Math.pow(k, index);
      const rounded = Math.round(value * Math.pow(10, dm)) / Math.pow(10, dm);

      return `${rounded} ${CONFIG.FILE_SIZE_UNITS[index]}`;
    } catch (error) {
      console.error('[FormatUtils] fileSize failed:', error);
      return '0 Bytes';
    }
  },

  /**
   * Format large numbers with K, M, B, T suffixes
   * @param {number} num - Number to format
   * @param {number} decimals - Decimal places (default: 1)
   * @returns {string} Formatted number
   */
  number(num, decimals = 1) {
    try {
      if (num === 0) return '0';
      if (isNaN(num)) return '0';

      const absNum = Math.abs(num);
      const sign = num < 0 ? '-' : '';

      if (absNum < CONFIG.NUMBER_BASE) {
        return `${sign}${absNum}`;
      }

      const k = CONFIG.NUMBER_BASE;
      const dm = decimals < 0 ? 0 : decimals;
      const i = Math.floor(Math.log(absNum) / Math.log(k));
      const index = Math.min(i, CONFIG.NUMBER_SUFFIXES.length - 1);

      const value = absNum / Math.pow(k, index);
      const rounded = Math.round(value * Math.pow(10, dm)) / Math.pow(10, dm);

      return `${sign}${rounded}${CONFIG.NUMBER_SUFFIXES[index]}`;
    } catch (error) {
      console.error('[FormatUtils] number failed:', error);
      return '0';
    }
  },

  /**
   * Format number with thousands separators
   * @param {number} num - Number to format
   * @param {string} separator - Thousands separator (default: ',')
   * @returns {string} Formatted number
   */
  numberWithSeparator(num, separator = ',') {
    try {
      return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, separator);
    } catch (error) {
      console.error('[FormatUtils] numberWithSeparator failed:', error);
      return String(num);
    }
  },

  /**
   * Format percentage
   * @param {number} value - Value (0-1 or 0-100)
   * @param {number} decimals - Decimal places (default: 0)
   * @param {boolean} isDecimal - Whether value is 0-1 (default: false)
   * @returns {string} Formatted percentage
   */
  percentage(value, decimals = 0, isDecimal = false) {
    try {
      const percent = isDecimal ? value * 100 : value;
      const rounded = Math.round(percent * Math.pow(10, decimals)) / Math.pow(10, decimals);
      return `${rounded}%`;
    } catch (error) {
      console.error('[FormatUtils] percentage failed:', error);
      return '0%';
    }
  },

  /**
   * Format currency
   * @param {number} amount - Amount to format
   * @param {string} currency - Currency code (default: 'USD')
   * @param {string} locale - Locale (default: undefined = user's locale)
   * @returns {string} Formatted currency
   */
  currency(amount, currency = 'USD', locale = undefined) {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
      }).format(amount);
    } catch (error) {
      console.error('[FormatUtils] currency failed:', error);
      return `${amount} ${currency}`;
    }
  },

  /**
   * Truncate text with ellipsis
   * @param {string} text - Text to truncate
   * @param {number} maxLength - Maximum length
   * @param {string} ellipsis - Ellipsis string (default: '...')
   * @returns {string} Truncated text
   */
  truncate(text, maxLength, ellipsis = '...') {
    try {
      if (!text) return '';
      if (text.length <= maxLength) return text;

      const truncated = text.slice(0, maxLength - ellipsis.length);
      return `${truncated}${ellipsis}`;
    } catch (error) {
      console.error('[FormatUtils] truncate failed:', error);
      return text || '';
    }
  },

  /**
   * Truncate text in the middle with ellipsis
   * @param {string} text - Text to truncate
   * @param {number} maxLength - Maximum length
   * @param {string} ellipsis - Ellipsis string (default: '...')
   * @returns {string} Truncated text
   */
  truncateMiddle(text, maxLength, ellipsis = '...') {
    try {
      if (!text) return '';
      if (text.length <= maxLength) return text;

      const charsToShow = maxLength - ellipsis.length;
      const frontChars = Math.ceil(charsToShow / 2);
      const backChars = Math.floor(charsToShow / 2);

      return `${text.slice(0, frontChars)}${ellipsis}${text.slice(-backChars)}`;
    } catch (error) {
      console.error('[FormatUtils] truncateMiddle failed:', error);
      return text || '';
    }
  },

  /**
   * Pluralize word based on count
   * @param {number} count - Count value
   * @param {string} singular - Singular form
   * @param {string} plural - Plural form (default: singular + 's')
   * @returns {string} Pluralized word
   */
  pluralize(count, singular, plural = null) {
    try {
      const pluralForm = plural !== null ? plural : `${singular}s`;
      return count === 1 ? singular : pluralForm;
    } catch (error) {
      console.error('[FormatUtils] pluralize failed:', error);
      return singular;
    }
  },

  /**
   * Format count with pluralized word
   * @param {number} count - Count value
   * @param {string} singular - Singular form
   * @param {string} plural - Plural form (default: singular + 's')
   * @returns {string} Formatted count with word
   */
  countWithWord(count, singular, plural = null) {
    try {
      const word = this.pluralize(count, singular, plural);
      return `${count} ${word}`;
    } catch (error) {
      console.error('[FormatUtils] countWithWord failed:', error);
      return `${count} ${singular}`;
    }
  },

  /**
   * Format boolean as Yes/No
   * @param {boolean} value - Boolean value
   * @param {string} trueText - Text for true (default: 'Yes')
   * @param {string} falseText - Text for false (default: 'No')
   * @returns {string} Formatted boolean
   */
  boolean(value, trueText = 'Yes', falseText = 'No') {
    return value ? trueText : falseText;
  },

  /**
   * Format phone number (US format)
   * @param {string} phone - Phone number
   * @returns {string} Formatted phone
   */
  phone(phone) {
    try {
      const cleaned = phone.replace(/\D/g, '');

      if (cleaned.length === 10) {
        return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
      }

      if (cleaned.length === 11 && cleaned[0] === '1') {
        return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
      }

      return phone;
    } catch (error) {
      console.error('[FormatUtils] phone failed:', error);
      return phone;
    }
  },

  /**
   * Format JSON with indentation
   * @param {*} data - Data to stringify
   * @param {number} indent - Indentation spaces (default: 2)
   * @returns {string} Formatted JSON
   */
  json(data, indent = 2) {
    try {
      return JSON.stringify(data, null, indent);
    } catch (error) {
      console.error('[FormatUtils] json failed:', error);
      return String(data);
    }
  },

  /**
   * Format latency/ping in milliseconds
   * @param {number} ms - Latency in milliseconds
   * @returns {string} Formatted latency
   */
  latency(ms) {
    try {
      if (ms < 0) return 'N/A';
      if (ms < 1) return '<1ms';
      if (ms < 1000) return `${Math.round(ms)}ms`;
      return `${(ms / 1000).toFixed(2)}s`;
    } catch (error) {
      console.error('[FormatUtils] latency failed:', error);
      return 'N/A';
    }
  },

  /**
   * Format FPS (frames per second)
   * @param {number} fps - FPS value
   * @returns {string} Formatted FPS
   */
  fps(fps) {
    try {
      if (isNaN(fps) || fps < 0) return '0 FPS';
      return `${Math.round(fps)} FPS`;
    } catch (error) {
      console.error('[FormatUtils] fps failed:', error);
      return '0 FPS';
    }
  },

  /**
   * Format memory size
   * @param {number} bytes - Memory in bytes
   * @returns {string} Formatted memory
   */
  memory(bytes) {
    return this.fileSize(bytes);
  },

  /**
   * Format CPU percentage
   * @param {number} value - CPU value (0-100)
   * @returns {string} Formatted CPU
   */
  cpu(value) {
    try {
      const clamped = Math.max(0, Math.min(100, value));
      return `${Math.round(clamped)}%`;
    } catch (error) {
      console.error('[FormatUtils] cpu failed:', error);
      return '0%';
    }
  },

  /**
   * Capitalize first letter of string
   * @param {string} str - String to capitalize
   * @returns {string} Capitalized string
   */
  capitalize(str) {
    try {
      if (!str) return '';
      return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    } catch (error) {
      console.error('[FormatUtils] capitalize failed:', error);
      return str;
    }
  },

  /**
   * Convert string to title case
   * @param {string} str - String to convert
   * @returns {string} Title case string
   */
  titleCase(str) {
    try {
      if (!str) return '';
      return str
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    } catch (error) {
      console.error('[FormatUtils] titleCase failed:', error);
      return str;
    }
  },

  /**
   * Convert camelCase to kebab-case
   * @param {string} str - CamelCase string
   * @returns {string} kebab-case string
   */
  camelToKebab(str) {
    try {
      return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    } catch (error) {
      console.error('[FormatUtils] camelToKebab failed:', error);
      return str;
    }
  },

  /**
   * Convert kebab-case to camelCase
   * @param {string} str - kebab-case string
   * @returns {string} camelCase string
   */
  kebabToCamel(str) {
    try {
      return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    } catch (error) {
      console.error('[FormatUtils] kebabToCamel failed:', error);
      return str;
    }
  },

  /**
   * Pad number with leading zeros
   * @param {number} num - Number to pad
   * @param {number} length - Target length (default: 2)
   * @returns {string} Padded number
   */
  padNumber(num, length = 2) {
    try {
      return String(num).padStart(length, '0');
    } catch (error) {
      console.error('[FormatUtils] padNumber failed:', error);
      return String(num);
    }
  },

  /**
   * Format list with commas and 'and'
   * @param {Array<string>} items - List items
   * @param {string} conjunction - Conjunction word (default: 'and')
   * @returns {string} Formatted list
   */
  list(items, conjunction = 'and') {
    try {
      if (!Array.isArray(items) || items.length === 0) return '';
      if (items.length === 1) return items[0];
      if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;

      const allButLast = items.slice(0, -1).join(', ');
      const last = items[items.length - 1];
      return `${allButLast}, ${conjunction} ${last}`;
    } catch (error) {
      console.error('[FormatUtils] list failed:', error);
      return items.join(', ');
    }
  },
});

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FormatUtils;
}

if (typeof window !== 'undefined') {
  window.FormatUtils = FormatUtils;
  console.log('📦 FormatUtils loaded');
}

