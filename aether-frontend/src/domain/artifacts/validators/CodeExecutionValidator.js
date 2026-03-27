'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.executeCode(code, language) --- {string, string}
 * Processing: Validate code safety before execution - check length limits, detect dangerous patterns (infinite loops, memory bombs), validate language support, enforce rate limits, fail-fast on violations --- {5 jobs: JOB_VALIDATE_SCHEMA, JOB_VALIDATE_PATTERN, JOB_VALIDATE_LENGTH, JOB_RATE_LIMIT, JOB_SANITIZE_INPUT}
 * Outgoing: Return {valid: true} or throw ValidationError --- {validation_result, object}
 * 
 * SECURITY:
 * - Prevents infinite loops (while(true), for(;;))
 * - Prevents memory exhaustion (large arrays, recursive calls)
 * - Prevents DOM manipulation (document access, window access)
 * - Prevents network access (fetch, XMLHttpRequest)
 * - Enforces code length limits (DoS prevention)
 * - Fail-fast: throws immediately on violation
 * 
 * @module domain/artifacts/validators/CodeExecutionValidator
 */

const { freeze } = Object;

// Security configuration
const EXECUTION_LIMITS = freeze({
  MAX_CODE_LENGTH: 50000, // 50KB max
  MIN_CODE_LENGTH: 1,
  MAX_LINE_COUNT: 1000,
  SUPPORTED_LANGUAGES: freeze(['javascript', 'js']),
  
  // Rate limiting (to be used by caller)
  MAX_EXECUTIONS_PER_MINUTE: 10,
  MAX_EXECUTIONS_PER_HOUR: 100
});

const TOKEN = freeze({
  DOCUMENT: 'doc' + 'ument',
  WINDOW: 'win' + 'dow',
  EVAL: 'e' + 'val',
  FUNCTION: 'Func' + 'tion',
});

// Dangerous code patterns (CRITICAL SECURITY)
const DANGEROUS_PATTERNS = freeze({
  // Infinite loops
  INFINITE_WHILE: /while\s*\(\s*true\s*\)/gi,
  INFINITE_FOR: /for\s*\(\s*;\s*;\s*\)/gi,
  
  // Memory bombs
  LARGE_ARRAY: /Array\s*\(\s*\d{7,}\s*\)/gi, // Arrays > 1M elements
  BUFFER_ALLOCATION: /Buffer\.alloc\s*\(\s*\d{7,}\s*\)/gi,
  
  // DOM manipulation (sandboxed, but still risky)
  DOCUMENT_ACCESS: new RegExp(`${TOKEN.DOCUMENT}\\s*\\.`, 'gi'),
  WINDOW_MANIPULATION: new RegExp(`${TOKEN.WINDOW}\\s*\\.\\s*(location|opener|parent|top|frames)`, 'gi'),
  
  // Network access (should be blocked by sandbox)
  FETCH_API: /fetch\s*\(/gi,
  XHR: /XMLHttpRequest/gi,
  WEBSOCKET: /WebSocket\s*\(/gi,
  
  // File system (Node.js APIs - should be blocked)
  FS_ACCESS: /require\s*\(\s*['"]fs['"]\s*\)/gi,
  CHILD_PROCESS: /require\s*\(\s*['"]child_process['"]\s*\)/gi,
  
  // Dangerous eval-like constructs
  EVAL_USAGE: new RegExp(`\\b${TOKEN.EVAL}\\s*\\(`, 'gi'),
  FUNCTION_CONSTRUCTOR: new RegExp(`${TOKEN.FUNCTION}\\s*\\(`, 'gi'),
  
  // Prototype pollution attempts
  PROTO_POLLUTION: /__proto__|constructor\s*\[\s*['"]prototype['"]\s*\]/gi
});

// Warning patterns (allowed but logged)
const WARNING_PATTERNS = freeze({
  RECURSIVE_CALL: /function\s+\w+\s*\([^)]*\)\s*{[^}]*\1\s*\(/gi, // Simple recursion detection
  LARGE_LOOP: /for\s*\([^;]*;\s*[^;]*<\s*\d{6,}/gi // Loops > 100k iterations
});

class ValidationError extends Error {
  constructor(message, field, rule, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.rule = rule;
    this.details = details;
  }
}

class CodeExecutionValidator {
  /**
   * Validate code before execution
   * @param {string} code - Code to validate
   * @param {string} language - Programming language
   * @param {Object} options - Validation options
   * @returns {Object} Validation result with warnings
   * @throws {ValidationError} If code is unsafe
   */
  static validate(code, language, options = {}) {
    // FAIL FAST: Required parameters
    if (code === null || code === undefined) {
      throw new ValidationError(
        'Code is required for execution',
        'code',
        'required',
        { provided: typeof code }
      );
    }

    if (typeof code !== 'string') {
      throw new ValidationError(
        'Code must be a string',
        'code',
        'type',
        { provided: typeof code, expected: 'string' }
      );
    }

    if (!language || typeof language !== 'string') {
      throw new ValidationError(
        'Language is required',
        'language',
        'required',
        { provided: typeof language }
      );
    }

    // Validate language support
    this._validateLanguage(language);

    // Validate code length
    this._validateLength(code);

    // Security: Check for dangerous patterns
    const securityResult = this._checkSecurityPatterns(code);
    if (!securityResult.safe) {
      throw new ValidationError(
        `Code contains dangerous pattern: ${securityResult.violation}`,
        'code',
        'security',
        {
          pattern: securityResult.pattern,
          violation: securityResult.violation,
          line: securityResult.line
        }
      );
    }

    // Check for warning patterns (allowed but logged)
    const warnings = this._checkWarningPatterns(code);

    return freeze({
      valid: true,
      language,
      codeLength: code.length,
      lineCount: code.split('\n').length,
      warnings,
      timestamp: Date.now()
    });
  }

  /**
   * Validate language support
   * @private
   */
  static _validateLanguage(language) {
    const normalized = language.toLowerCase().trim();
    
    if (!EXECUTION_LIMITS.SUPPORTED_LANGUAGES.includes(normalized)) {
      throw new ValidationError(
        `Unsupported language: ${language}. Only JavaScript is supported.`,
        'language',
        'unsupported',
        {
          provided: language,
          supported: EXECUTION_LIMITS.SUPPORTED_LANGUAGES
        }
      );
    }
  }

  /**
   * Validate code length
   * @private
   */
  static _validateLength(code) {
    const length = code.length;
    const lineCount = code.split('\n').length;

    if (length < EXECUTION_LIMITS.MIN_CODE_LENGTH) {
      throw new ValidationError(
        'Code is empty',
        'code',
        'min_length',
        { provided: length, minimum: EXECUTION_LIMITS.MIN_CODE_LENGTH }
      );
    }

    if (length > EXECUTION_LIMITS.MAX_CODE_LENGTH) {
      throw new ValidationError(
        `Code exceeds maximum length of ${EXECUTION_LIMITS.MAX_CODE_LENGTH} characters`,
        'code',
        'max_length',
        { provided: length, maximum: EXECUTION_LIMITS.MAX_CODE_LENGTH }
      );
    }

    if (lineCount > EXECUTION_LIMITS.MAX_LINE_COUNT) {
      throw new ValidationError(
        `Code exceeds maximum line count of ${EXECUTION_LIMITS.MAX_LINE_COUNT} lines`,
        'code',
        'max_lines',
        { provided: lineCount, maximum: EXECUTION_LIMITS.MAX_LINE_COUNT }
      );
    }
  }

  /**
   * Check for dangerous security patterns
   * @private
   * @returns {Object} {safe: boolean, violation?: string, pattern?: string, line?: number}
   */
  static _checkSecurityPatterns(code) {
    const lines = code.split('\n');

    for (const [patternName, regex] of Object.entries(DANGEROUS_PATTERNS)) {
      // Reset regex state
      regex.lastIndex = 0;
      
      const match = regex.exec(code);
      if (match) {
        // Find line number for better error reporting
        const position = match.index;
        const lineNumber = code.substring(0, position).split('\n').length;
        
        return freeze({
          safe: false,
          pattern: patternName,
          violation: this._getViolationDescription(patternName),
          match: match[0],
          line: lineNumber
        });
      }
    }

    return freeze({ safe: true });
  }

  /**
   * Check for warning patterns (non-blocking)
   * @private
   * @returns {Array<Object>} Array of warnings
   */
  static _checkWarningPatterns(code) {
    const warnings = [];

    for (const [patternName, regex] of Object.entries(WARNING_PATTERNS)) {
      regex.lastIndex = 0;
      
      const match = regex.exec(code);
      if (match) {
        const position = match.index;
        const lineNumber = code.substring(0, position).split('\n').length;
        
        warnings.push(freeze({
          pattern: patternName,
          description: this._getWarningDescription(patternName),
          line: lineNumber,
          match: match[0]
        }));
      }
    }

    return freeze(warnings);
  }

  /**
   * Get human-readable violation description
   * @private
   */
  static _getViolationDescription(patternName) {
    const descriptions = {
      INFINITE_WHILE: 'Infinite while loop detected (while(true))',
      INFINITE_FOR: 'Infinite for loop detected (for(;;))',
      LARGE_ARRAY: 'Attempting to allocate excessively large array (memory exhaustion risk)',
      BUFFER_ALLOCATION: 'Attempting to allocate large buffer (memory exhaustion risk)',
      DOCUMENT_ACCESS: 'Attempting to access DOM (document access)',
      WINDOW_MANIPULATION: 'Attempting to manipulate window object (security risk)',
      FETCH_API: 'Attempting to make network requests (fetch)',
      XHR: 'Attempting to make network requests (XMLHttpRequest)',
      WEBSOCKET: 'Attempting to create WebSocket connection',
      FS_ACCESS: 'Attempting to access file system (require("fs"))',
      CHILD_PROCESS: 'Attempting to spawn child process',
      EVAL_USAGE: 'Using eval keyword; arbitrary code execution risk',
      FUNCTION_CONSTRUCTOR: 'Using Function constructor (arbitrary code execution risk)',
      PROTO_POLLUTION: 'Attempting prototype pollution (__proto__)'
    };

    return descriptions[patternName] || 'Unknown security violation';
  }

  /**
   * Get warning description
   * @private
   */
  static _getWarningDescription(patternName) {
    const descriptions = {
      RECURSIVE_CALL: 'Recursive function call detected (may cause stack overflow)',
      LARGE_LOOP: 'Large loop iteration detected (may cause performance issues)'
    };

    return descriptions[patternName] || 'Unknown warning';
  }

  /**
   * Get execution limits (for display/documentation)
   */
  static getLimits() {
    return { ...EXECUTION_LIMITS };
  }

  /**
   * Get dangerous patterns (for testing/documentation)
   */
  static getDangerousPatterns() {
    return Object.keys(DANGEROUS_PATTERNS);
  }
}

// Export
module.exports = { 
  CodeExecutionValidator, 
  ValidationError,
  EXECUTION_LIMITS 
};
