'use strict';

/**
 * @.architecture
 *
 * Incoming: Renderer user input values --- {string, text}
 * Processing: Validate min/max length plus basic SQL/command/XSS guards --- {3 jobs: JOB_VALIDATE_SCHEMA, JOB_ESCAPE_HTML, JOB_TRACK_ENTITY}
 * Outgoing: Validation result or ValidationError --- {boolean | Error, validation_result}
 */

const { freeze } = Object;

const SECURITY_PATTERNS = freeze({
  sqlInjection: /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|DECLARE)\b|--|\/\*|\*\/|;|'|")/gi,
  commandInjection: /(\$\(|\$\{|\|\||&&|;|`)/g,
  xssPatterns: /<script|javascript:|onerror=|onload=|<iframe|eval\(|expression\(/gi,
});

class ValidationError extends Error {
  constructor(message, rule) {
    super(message);
    this.name = 'ValidationError';
    this.rule = rule;
    this.isValidationError = true;
  }
}

class InputValidator {
  constructor(options = {}) {
    this.maxStringLength = options?.maxStringLength ?? 8000;
  }

  validateString(value, constraints = {}) {
    // Guard: default params only apply for undefined, not null
    constraints = constraints ?? {};

    if (typeof value !== 'string') {
      throw new ValidationError('Value must be a string', 'type');
    }

    const minLength = constraints.minLength ?? 0;
    const maxLength = constraints.maxLength ?? this.maxStringLength;

    if (value.length < minLength) {
      throw new ValidationError(`String too short (min: ${minLength})`, 'minLength');
    }

    if (value.length > maxLength) {
      throw new ValidationError(`String too long (max: ${maxLength})`, 'maxLength');
    }

    if (constraints.noSqlInjection) {
      SECURITY_PATTERNS.sqlInjection.lastIndex = 0;
      if (SECURITY_PATTERNS.sqlInjection.test(value)) {
        throw new ValidationError('Potential SQL injection detected', 'security');
      }
    }

    if (constraints.noCommandInjection) {
      SECURITY_PATTERNS.commandInjection.lastIndex = 0;
      if (SECURITY_PATTERNS.commandInjection.test(value)) {
        throw new ValidationError('Potential command injection detected', 'security');
      }
    }

    if (constraints.noXss) {
      SECURITY_PATTERNS.xssPatterns.lastIndex = 0;
      if (SECURITY_PATTERNS.xssPatterns.test(value)) {
        throw new ValidationError('Potential XSS pattern detected', 'security');
      }
    }

    return true;
  }
}

module.exports = {
  InputValidator,
  ValidationError
};
