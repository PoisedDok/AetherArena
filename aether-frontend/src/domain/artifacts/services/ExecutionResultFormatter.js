'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.executeCode() result --- {execution_result, any}
 * Processing: Format execution results for display, handle different result types (null/undefined/string/number/boolean/object), serialize objects to JSON, handle serialization errors gracefully --- {3 jobs: JOB_FORMAT_OUTPUT, JOB_SERIALIZE_DATA, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return formatted string for display --- {formatted_result, string}
 * 
 * ARCHITECTURE:
 * - Pure business logic (no I/O, no side effects)
 * - Handles all JavaScript types consistently
 * - Graceful error handling for non-serializable objects
 * - Provides user-friendly output formatting
 * - Testable in isolation
 * 
 * @module domain/artifacts/services/ExecutionResultFormatter
 */

const { freeze } = Object;

// Formatting configuration
const FORMAT_CONFIG = freeze({
  MAX_STRING_LENGTH: 10000, // Truncate very long strings
  MAX_JSON_DEPTH: 10, // Prevent deeply nested object serialization issues
  INDENT_SIZE: 2, // JSON indentation
  
  // Result type labels
  LABELS: freeze({
    SUCCESS: 'Execution complete',
    NULL: 'null',
    UNDEFINED: 'undefined',
    STRING: 'Output',
    RESULT: 'Result',
    JSON_RESULT: 'Result (JSON)',
    ERROR: 'Error formatting result'
  })
});

class ExecutionResultFormatter {
  /**
   * Format execution result for display
   * @param {*} result - Execution result (any type)
   * @param {Object} options - Formatting options
   * @param {boolean} options.truncate - Truncate long results (default: true)
   * @param {number} options.maxLength - Maximum result length (default: 10000)
   * @returns {string} Formatted result string
   */
  static format(result, options = {}) {
    const {
      truncate = true,
      maxLength = FORMAT_CONFIG.MAX_STRING_LENGTH
    } = options;

    try {
      let formatted = this._formatByType(result);
      
      // Truncate if needed
      if (truncate && formatted.length > maxLength) {
        const truncated = formatted.substring(0, maxLength);
        formatted = `${truncated}\n\n... (truncated, original length: ${formatted.length} characters)`;
      }
      
      return formatted;
    } catch (error) {
      // Fallback: if formatting fails completely, return safe string
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.ERROR}: ${error.message}`;
    }
  }

  /**
   * Format result based on type
   * @private
   */
  static _formatByType(result) {
    // Handle null
    if (result === null) {
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: ${FORMAT_CONFIG.LABELS.NULL}`;
    }

    // Handle undefined
    if (result === undefined) {
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: ${FORMAT_CONFIG.LABELS.UNDEFINED}`;
    }

    // Handle strings
    if (typeof result === 'string') {
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.STRING}:\n${result}`;
    }

    // Handle numbers and booleans
    if (typeof result === 'number' || typeof result === 'boolean') {
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: ${result}`;
    }

    // Handle functions
    if (typeof result === 'function') {
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: [Function: ${result.name || 'anonymous'}]`;
    }

    // Handle symbols
    if (typeof result === 'symbol') {
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: ${String(result)}`;
    }

    // Handle objects (including arrays, dates, etc.)
    if (typeof result === 'object') {
      return this._formatObject(result);
    }

    // Fallback for unknown types
    return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: ${String(result)}`;
  }

  /**
   * Format objects (including arrays, dates, etc.)
   * @private
   */
  static _formatObject(obj) {
    try {
      // Handle arrays
      if (Array.isArray(obj)) {
        const jsonStr = JSON.stringify(obj, null, FORMAT_CONFIG.INDENT_SIZE);
        return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.JSON_RESULT} (Array, length: ${obj.length}):\n${jsonStr}`;
      }

      // Handle dates
      if (obj instanceof Date) {
        return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: ${obj.toISOString()}`;
      }

      // Handle errors
      if (obj instanceof Error) {
        return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT} (Error):\n${obj.name}: ${obj.message}\n${obj.stack || ''}`;
      }

      // Handle RegExp
      if (obj instanceof RegExp) {
        return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: ${obj.toString()}`;
      }

      // Handle Maps
      if (obj instanceof Map) {
        const entries = Array.from(obj.entries());
        const jsonStr = JSON.stringify(entries, null, FORMAT_CONFIG.INDENT_SIZE);
        return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.JSON_RESULT} (Map, size: ${obj.size}):\n${jsonStr}`;
      }

      // Handle Sets
      if (obj instanceof Set) {
        const values = Array.from(obj.values());
        const jsonStr = JSON.stringify(values, null, FORMAT_CONFIG.INDENT_SIZE);
        return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.JSON_RESULT} (Set, size: ${obj.size}):\n${jsonStr}`;
      }

      // Handle plain objects
      const jsonStr = JSON.stringify(obj, this._getReplacer(), FORMAT_CONFIG.INDENT_SIZE);
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.JSON_RESULT}:\n${jsonStr}`;
      
    } catch (error) {
      // Fallback if JSON.stringify fails (circular references, etc.)
      return this._formatNonSerializable(obj, error);
    }
  }

  /**
   * Get JSON replacer function to handle non-serializable values
   * @private
   */
  static _getReplacer() {
    const seen = new WeakSet();
    
    return (key, value) => {
      // Handle circular references
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular Reference]';
        }
        seen.add(value);
      }

      // Handle functions
      if (typeof value === 'function') {
        return `[Function: ${value.name || 'anonymous'}]`;
      }

      // Handle symbols
      if (typeof value === 'symbol') {
        return String(value);
      }

      // Handle undefined (normally omitted by JSON.stringify)
      if (value === undefined) {
        return '[undefined]';
      }

      // Handle BigInt
      if (typeof value === 'bigint') {
        return `${value}n`;
      }

      return value;
    };
  }

  /**
   * Format non-serializable objects
   * @private
   */
  static _formatNonSerializable(obj, error) {
    try {
      // Try Object.prototype.toString for type info
      const typeString = Object.prototype.toString.call(obj);
      
      // Try to get object keys
      let keysInfo = '';
      try {
        const keys = Object.keys(obj);
        keysInfo = keys.length > 0 
          ? `\nKeys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`
          : '\nKeys: (none)';
      } catch (e) {
        keysInfo = '\nKeys: (unable to enumerate)';
      }

      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: ${typeString}${keysInfo}\n\nNote: Object could not be fully serialized (${error.message})`;
    } catch (fallbackError) {
      // Ultimate fallback
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\n${FORMAT_CONFIG.LABELS.RESULT}: ${String(obj)}`;
    }
  }

  /**
   * Format multiple results (for batch execution)
   * @param {Array} results - Array of execution results
   * @param {Object} options - Formatting options
   * @returns {string} Formatted results
   */
  static formatBatch(results, options = {}) {
    if (!Array.isArray(results)) {
      throw new TypeError('Results must be an array');
    }

    if (results.length === 0) {
      return `${FORMAT_CONFIG.LABELS.SUCCESS}\n\nNo results`;
    }

    const formatted = results.map((result, index) => {
      const resultStr = this.format(result, options);
      return `[${index + 1}] ${resultStr}`;
    });

    return formatted.join('\n\n---\n\n');
  }

  /**
   * Get formatting configuration (for display/documentation)
   */
  static getConfig() {
    return { ...FORMAT_CONFIG };
  }
}

// Export
module.exports = { 
  ExecutionResultFormatter,
  FORMAT_CONFIG
};
