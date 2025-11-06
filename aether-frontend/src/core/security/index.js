'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export RateLimiter, TokenBucket, RateLimitError, CspManager, Sanitizer, InputValidator, ValidationError for centralized security API --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: All modules (security utilities) --- {module_exports, javascript_object}
 * 
 * 
 * @module core/security/index
 * 
 * Security Module - Core Security Layer
 * ============================================================================
 * Unified security module providing:
 * - Rate limiting (RateLimiter)
 * - Content Security Policy management (CspManager)
 * - HTML sanitization (Sanitizer)
 * - Input validation (InputValidator)
 * 
 * @module core/security
 */

const { RateLimiter, TokenBucket, RateLimitError, DEFAULT_LIMITS } = require('./RateLimiter');
const { CspManager, DEFAULT_POLICIES } = require('./CspManager');
const { Sanitizer, PROFILES } = require('./Sanitizer');
const { InputValidator, ValidationError, VALIDATION_RULES } = require('./InputValidator');

// Export all security modules
module.exports = {
  // Rate limiting
  RateLimiter,
  TokenBucket,
  RateLimitError,
  DEFAULT_LIMITS,
  
  // CSP
  CspManager,
  DEFAULT_POLICIES,
  
  // Sanitization
  Sanitizer,
  PROFILES,
  
  // Validation
  InputValidator,
  ValidationError,
  VALIDATION_RULES,
};

// Browser exports
if (typeof window !== 'undefined') {
  window.Security = {
    RateLimiter,
    TokenBucket,
    RateLimitError,
    CspManager,
    Sanitizer,
    InputValidator,
    ValidationError,
  };
  console.log('📦 Security module loaded');
}

