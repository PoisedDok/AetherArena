'use strict';

/**
 * @.architecture
 * 
 * Incoming: Main process (session.webRequest CSP injection), Renderer (meta tag injection calls) --- {csp_types.directives, object}
 * Processing: Build CSP policy string from directives, generate cryptographic nonces for inline scripts, validate production policies, handle CSP violation events, merge custom directives with defaults --- {4 jobs: JOB_INITIALIZE, JOB_VALIDATE_SCHEMA, JOB_UPDATE_STATE, JOB_EMIT_EVENT}
 * Outgoing: CSP header string, meta tag injection, violation tracking --- {csp_types.policy_header, string}
 * 
 * 
 * @module core/security/CspManager
 */

const { freeze } = Object;

/**
 * Default CSP directives by environment
 */
const DEFAULT_POLICIES = freeze({
  // Production policy (strict)
  production: freeze({
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'ws:', 'wss:'],
    'media-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'frame-src': ["'self'"],
    'worker-src': ["'self'"],
    'child-src': ["'self'"],
  }),
  
  // Development policy (permissive)
  development: freeze({
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'http:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
    'media-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'self'"],
    'frame-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
  }),
});

/**
 * CSP Manager
 */
class CspManager {
  constructor(options = {}) {
    // Handle null explicitly
    const opts = options || {};
    this.environment = opts.environment || 'development';
    this.enabled = opts.enabled !== false;
    this.reportOnly = opts.reportOnly || false;
    this.reportUri = opts.reportUri || null;
    
    // Get base policy for environment
    const basePolicy = DEFAULT_POLICIES[this.environment] || DEFAULT_POLICIES.development;
    
    // Merge with custom directives
    this.directives = this._mergeDirectives(
      basePolicy,
      opts.directives || {}
    );
    
    // Nonce management
    this.currentNonce = null;
    this.nonceMap = new Map(); // Track nonces by context
    
    // Violation tracking
    this.violations = [];
    this.maxViolations = opts.maxViolations || 100;
    
    // Install violation handler if in browser
    if (typeof window !== 'undefined') {
      this._installViolationHandler();
    }
  }

  /**
   * Merge base directives with custom directives
   * @param {Object} base - Base directives
   * @param {Object} custom - Custom directives
   * @returns {Object}
   * @private
   */
  _mergeDirectives(base, custom) {
    const merged = {};
    
    // Copy base directives
    for (const [key, value] of Object.entries(base)) {
      merged[key] = Array.isArray(value) ? [...value] : [value];
    }
    
    // Merge custom directives
    for (const [key, value] of Object.entries(custom)) {
      if (merged[key]) {
        // Merge arrays
        const values = Array.isArray(value) ? value : [value];
        merged[key] = [...new Set([...merged[key], ...values])];
      } else {
        // New directive
        merged[key] = Array.isArray(value) ? value : [value];
      }
    }
    
    return merged;
  }

  /**
   * Generate cryptographic nonce
   * @returns {string}
   */
  generateNonce() {
    if (typeof window !== 'undefined' && window.crypto) {
      const array = new Uint8Array(16);
      window.crypto.getRandomValues(array);
      this.currentNonce = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
    } else {
      // Fallback to timestamp + random
      this.currentNonce = Date.now().toString(36) + Math.random().toString(36).substring(2);
    }
    
    return this.currentNonce;
  }

  /**
   * Get current nonce
   * @returns {string|null}
   */
  getNonce() {
    return this.currentNonce;
  }

  /**
   * Add nonce to policy for inline scripts/styles
   * @param {string} nonce - Nonce value
   * @param {Array<string>} directives - Directives to add nonce to (default: script-src, style-src)
   */
  addNonce(nonce, directives = ['script-src', 'style-src']) {
    for (const directive of directives) {
      if (this.directives[directive]) {
        const nonceValue = `'nonce-${nonce}'`;
        if (!this.directives[directive].includes(nonceValue)) {
          this.directives[directive].push(nonceValue);
        }
      }
    }
    
    this.currentNonce = nonce;
  }

  /**
   * Build CSP header value
   * @returns {string}
   */
  buildPolicy() {
    const parts = [];
    
    for (const [directive, values] of Object.entries(this.directives)) {
      if (values.length > 0) {
        parts.push(`${directive} ${values.join(' ')}`);
      } else {
        parts.push(directive);
      }
    }
    
    return parts.join('; ');
  }

  /**
   * Get CSP header name
   * @returns {string}
   */
  getHeaderName() {
    return this.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  }

  /**
   * Get CSP as HTTP header
   * @returns {Object} - { name: string, value: string }
   */
  getHeader() {
    return {
      name: this.getHeaderName(),
      value: this.buildPolicy(),
    };
  }

  /**
   * Inject CSP meta tag into document
   * @param {Document} doc - Document object (default: window.document)
   */
  injectMetaTag(doc = typeof window !== 'undefined' ? window.document : null) {
    if (!doc || !this.enabled) {
      return;
    }

    // Remove existing CSP meta tags
    const existing = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
    existing.forEach(tag => tag.remove());

    // Create new CSP meta tag
    const meta = doc.createElement('meta');
    meta.setAttribute('http-equiv', this.getHeaderName());
    meta.setAttribute('content', this.buildPolicy());
    
    // Insert at beginning of head
    const head = doc.head || doc.getElementsByTagName('head')[0];
    if (head.firstChild) {
      head.insertBefore(meta, head.firstChild);
    } else {
      head.appendChild(meta);
    }
  }

  /**
   * Install CSP violation handler
   * @private
   */
  _installViolationHandler() {
    if (typeof window === 'undefined') {
      return;
    }

    // Remove existing handler
    if (this._violationHandler) {
      document.removeEventListener('securitypolicyviolation', this._violationHandler);
    }

    // Install new handler
    this._violationHandler = (event) => {
      const violation = {
        timestamp: Date.now(),
        blockedUri: event.blockedURI,
        documentUri: event.documentURI,
        effectiveDirective: event.effectiveDirective,
        originalPolicy: event.originalPolicy,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        columnNumber: event.columnNumber,
        sample: event.sample,
      };
      
      this._recordViolation(violation);
    };

    document.addEventListener('securitypolicyviolation', this._violationHandler);
  }

  /**
   * Record CSP violation
   * @param {Object} violation - Violation details
   * @private
   */
  _recordViolation(violation) {
    this.violations.push(violation);
    
    // Trim violations array if too large
    if (this.violations.length > this.maxViolations) {
      this.violations.shift();
    }
    
    // Log in development
    if (this.environment === 'development') {
      console.warn('[CspManager] CSP Violation:', violation);
    }
    
    // Report if URI configured
    if (this.reportUri) {
      this._reportViolation(violation);
    }
  }

  /**
   * Report violation to server
   * @param {Object} violation - Violation details
   * @private
   */
  async _reportViolation(violation) {
    try {
      await fetch(this.reportUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cspReport: violation }),
      });
    } catch (error) {
      console.error('[CspManager] Failed to report violation:', error);
    }
  }

  /**
   * Get CSP violations
   * @returns {Array<Object>}
   */
  getViolations() {
    return [...this.violations];
  }

  /**
   * Clear violations
   */
  clearViolations() {
    this.violations = [];
  }

  /**
   * Validate policy directives
   * @returns {Object} - { valid: boolean, errors: Array<string> }
   */
  validate() {
    const errors = [];
    
    // Check for unsafe directives in production
    if (this.environment === 'production') {
      const unsafePatterns = ["'unsafe-inline'", "'unsafe-eval'"];
      
      for (const [directive, values] of Object.entries(this.directives)) {
        for (const pattern of unsafePatterns) {
          if (values.includes(pattern)) {
            errors.push(`Unsafe directive in production: ${directive} ${pattern}`);
          }
        }
      }
    }
    
    // Check for required directives
    const required = ['default-src', 'script-src', 'object-src'];
    for (const directive of required) {
      if (!this.directives[directive]) {
        errors.push(`Missing required directive: ${directive}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get policy info
   * @returns {Object}
   */
  getInfo() {
    return freeze({
      environment: this.environment,
      enabled: this.enabled,
      reportOnly: this.reportOnly,
      reportUri: this.reportUri,
      directives: { ...this.directives },
      currentNonce: this.currentNonce,
      violations: this.violations.length,
      policy: this.buildPolicy(),
    });
  }

  /**
   * Enable CSP
   */
  enable() {
    this.enabled = true;
  }

  /**
   * Disable CSP
   */
  disable() {
    this.enabled = false;
  }

  /**
   * Switch to report-only mode
   */
  setReportOnly(reportOnly = true) {
    this.reportOnly = reportOnly;
  }
}

// Export
module.exports = { CspManager, DEFAULT_POLICIES };

if (typeof window !== 'undefined') {
  window.CspManager = CspManager;
  console.log('📦 CspManager loaded');
}

