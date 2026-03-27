/**
 * Phase 11: Security & Compliance Validation Tests
 * ============================================================================
 * Comprehensive security validation tests for Phase 11 completion:
 * - CSP enforcement
 * - Renderer sandboxing
 * - Content sanitization
 * - External link protection
 * - Permission management
 * - Security auditing
 * 
 * @module tests/integration/security/phase11-validation
 */

const { SecurityManager } = require('../../../src/main/security/SecurityManager');
const { CspManager } = require('../../../src/core/security/CspManager');
const { Sanitizer } = require('../../../src/core/security/Sanitizer');
const { ExternalLinkHandler } = require('../../../src/main/security/ExternalLinkHandler');
const { PermissionHandler, PERMISSIONS } = require('../../../src/main/security/PermissionHandler');
const { RateLimiter } = require('../../../src/core/security/RateLimiter');
const { InputValidator } = require('../../../src/core/security/InputValidator');

describe('Phase 11: Security & Compliance', () => {
  describe('SecurityManager', () => {
    let securityManager;

    beforeEach(() => {
      securityManager = new SecurityManager({
        mode: 'strict',
        enableAuditing: true,
      });
    });

    test('should initialize with strict security profile', () => {
      expect(securityManager).toBeDefined();
      expect(securityManager.options.mode).toBe('strict');
      expect(securityManager.profile).toBeDefined();
    });

    test('should provide secure BrowserWindow preferences', () => {
      const prefs = securityManager.getSecurePreferences();
      
      // Critical security settings
      expect(prefs.sandbox).toBe(true);
      expect(prefs.nodeIntegration).toBe(false);
      expect(prefs.contextIsolation).toBe(true);
      expect(prefs.webSecurity).toBe(true);
      expect(prefs.allowRunningInsecureContent).toBe(false);
      expect(prefs.enableRemoteModule).toBe(false);
    });

    test('should track security events', () => {
      securityManager._recordSecurityEvent('test-event', { test: 'data' });
      
      const events = securityManager.getSecurityEvents();
      expect(events.length).toBeGreaterThan(0);
      
      const testEvent = events.find(e => e.type === 'test-event');
      expect(testEvent).toBeDefined();
      expect(testEvent.data.test).toBe('data');
    });

    test('should run security audit', () => {
      const audit = securityManager.audit();
      
      expect(audit).toBeDefined();
      expect(audit.timestamp).toBeDefined();
      expect(audit.mode).toBe('strict');
      expect(audit.csp).toBeDefined();
      expect(audit.sandbox).toBeDefined();
      expect(audit.permissions).toBeDefined();
      expect(audit.recommendations).toBeDefined();
    });

    test('should generate security recommendations', () => {
      const audit = securityManager.audit();
      const recommendations = audit.recommendations;
      
      expect(Array.isArray(recommendations)).toBe(true);
      
      // With strict profile, should have minimal recommendations
      const criticalIssues = recommendations.filter(r => r.severity === 'critical');
      expect(criticalIssues.length).toBe(0);
    });

    test('should filter security events', () => {
      securityManager._recordSecurityEvent('type-a', {});
      securityManager._recordSecurityEvent('type-b', {});
      securityManager._recordSecurityEvent('type-a', {});
      
      const filteredEvents = securityManager.getSecurityEvents({
        type: 'type-a',
      });
      
      expect(filteredEvents.length).toBe(2);
      expect(filteredEvents.every(e => e.type === 'type-a')).toBe(true);
    });

    test('should limit security events history', () => {
      const maxEvents = securityManager.maxEvents;
      
      // Add more events than the limit
      for (let i = 0; i < maxEvents + 100; i++) {
        securityManager._recordSecurityEvent('test', { index: i });
      }
      
      const events = securityManager.getSecurityEvents();
      expect(events.length).toBeLessThanOrEqual(maxEvents);
    });
  });

  describe('Content Security Policy (CSP)', () => {
    let cspManager;

    beforeEach(() => {
      cspManager = new CspManager({
        environment: 'production',
        enabled: true,
        reportOnly: false,
      });
    });

    test('should enforce strict CSP in production', () => {
      const policy = cspManager.buildPolicy();
      
      expect(policy).toBeDefined();
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("object-src 'none'");
    });

    test('should not allow unsafe directives in production', () => {
      const policy = cspManager.buildPolicy();
      
      expect(policy).not.toContain('unsafe-inline');
      expect(policy).not.toContain('unsafe-eval');
    });

    test('should generate cryptographic nonce', () => {
      const nonce = cspManager.generateNonce();
      
      expect(nonce).toBeDefined();
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBeGreaterThan(0);
    });

    test('should add nonce to policy', () => {
      const nonce = cspManager.generateNonce();
      cspManager.addNonce(nonce);
      
      const policy = cspManager.buildPolicy();
      expect(policy).toContain(`'nonce-${nonce}'`);
    });

    test('should validate CSP policy', () => {
      const validation = cspManager.validate();
      
      expect(validation).toBeDefined();
      expect(validation.valid).toBe(true);
      expect(validation.errors.length).toBe(0);
    });

    test('should detect CSP violations', () => {
      const violation = {
        blockedUri: 'https://evil.com/script.js',
        effectiveDirective: 'script-src',
        violatedDirective: "script-src 'self'",
      };
      
      cspManager._recordViolation(violation);
      
      const violations = cspManager.getViolations();
      expect(violations.length).toBeGreaterThan(0);
    });

    test('should provide CSP header', () => {
      const header = cspManager.getHeader();
      
      expect(header).toBeDefined();
      expect(header.name).toBe('Content-Security-Policy');
      expect(header.value).toBeDefined();
    });

    test('should support report-only mode', () => {
      cspManager.setReportOnly(true);
      
      const headerName = cspManager.getHeaderName();
      expect(headerName).toBe('Content-Security-Policy-Report-Only');
    });
  });

  describe('Content Sanitization', () => {
    let sanitizer;

    beforeEach(() => {
      sanitizer = new Sanitizer({
        defaultProfile: 'default',
      });
    });

    test('should sanitize HTML content', () => {
      const dirty = '<script>alert("XSS")</script><p>Safe content</p>';
      const clean = sanitizer.sanitizeHTML(dirty);
      
      expect(clean).not.toContain('<script>');
      expect(clean).toContain('<p>Safe content</p>');
    });

    test('should block dangerous URL schemes', () => {
      const dangerousUrls = [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:alert(1)',
      ];
      
      for (const url of dangerousUrls) {
        const result = sanitizer.sanitizeURL(url);
        expect(result).toBeNull();
      }
    });

    test('should allow safe URL schemes', () => {
      const safeUrls = [
        'https://example.com',
        'http://localhost:3000',
        'mailto:test@example.com',
      ];
      
      for (const url of safeUrls) {
        const result = sanitizer.sanitizeURL(url);
        expect(result).toBeTruthy();
      }
    });

    test('should sanitize with strict profile', () => {
      const html = '<p>Text</p><strong>Bold</strong>';
      const clean = sanitizer.sanitizeHTML(html, { profile: 'strict' });
      
      // Strict profile removes all HTML
      expect(clean).not.toContain('<p>');
      expect(clean).not.toContain('<strong>');
      expect(clean).toContain('Text');
      expect(clean).toContain('Bold');
    });

    test('should strip all HTML tags', () => {
      const html = '<div><p>Text <strong>bold</strong></p></div>';
      const text = sanitizer.stripHTML(html);
      
      expect(text).toBe('Text bold');
    });

    test('should check if content is safe', () => {
      const safeContent = '<p>Safe content</p>';
      const unsafeContent = '<script>alert(1)</script><p>Content</p>';
      
      expect(sanitizer.isSafe(safeContent)).toBe(true);
      expect(sanitizer.isSafe(unsafeContent)).toBe(false);
    });

    test('should track sanitization statistics', () => {
      sanitizer.sanitizeHTML('<p>Test 1</p>');
      sanitizer.sanitizeHTML('<p>Test 2</p>');
      sanitizer.sanitizeHTML('<p>Test 3</p>');
      
      const stats = sanitizer.getStats();
      expect(stats.totalSanitizations).toBeGreaterThanOrEqual(3);
    });

    test('should sanitize attributes', () => {
      const dangerous = 'javascript:alert(1)';
      const safe = sanitizer.sanitizeAttribute(dangerous, 'href');
      
      expect(safe).toBe('');
    });
  });

  describe('External Link Protection', () => {
    let handler;

    beforeEach(() => {
      handler = new ExternalLinkHandler({
        openExternal: false, // Disable for testing
        logBlocked: false,
      });
    });

    test('should identify allowed schemes', () => {
      expect(handler.isAllowedScheme('file:///path/to/file')).toBe(true);
      expect(handler.isAllowedScheme('about:blank')).toBe(true);
      expect(handler.isAllowedScheme('http://example.com')).toBe(false);
    });

    test('should identify external schemes', () => {
      expect(handler.isExternalScheme('http://example.com')).toBe(true);
      expect(handler.isExternalScheme('https://example.com')).toBe(true);
      expect(handler.isExternalScheme('mailto:test@example.com')).toBe(true);
      expect(handler.isExternalScheme('file:///path')).toBe(false);
    });

    test('should block dangerous URL patterns', () => {
      const dangerousUrls = [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:alert(1)',
        'file://../../../etc/passwd',
      ];
      
      for (const url of dangerousUrls) {
        expect(handler.isBlocked(url)).toBe(true);
      }
    });

    test('should determine correct action for URLs', () => {
      expect(handler.determineAction('file:///path')).toBe('allow');
      expect(handler.determineAction('http://example.com')).toBe('external');
      expect(handler.determineAction('javascript:alert(1)')).toBe('block');
    });

    test('should handle path traversal attempts', () => {
      const traversalUrls = [
        'file:///../../../etc/passwd',
        'file:///../../windows/system32',
      ];
      
      for (const url of traversalUrls) {
        expect(handler.isBlocked(url)).toBe(true);
      }
    });
  });

  describe('Permission Management', () => {
    let handler;

    beforeEach(() => {
      handler = new PermissionHandler({
        mode: 'production',
        logRequests: false,
        logDenials: false,
      });
    });

    test('should deny sensitive permissions in production', () => {
      expect(handler.isAllowed(PERMISSIONS.GEOLOCATION)).toBe(false);
      expect(handler.isAllowed(PERMISSIONS.NOTIFICATIONS)).toBe(false);
      expect(handler.isAllowed(PERMISSIONS.USB)).toBe(false);
      expect(handler.isAllowed(PERMISSIONS.SERIAL)).toBe(false);
      expect(handler.isAllowed(PERMISSIONS.BLUETOOTH)).toBe(false);
    });

    test('should allow required permissions', () => {
      // Media should be allowed for voice input
      expect(handler.isAllowed(PERMISSIONS.MEDIA)).toBe(true);
      
      // Clipboard write should be allowed
      expect(handler.isAllowed(PERMISSIONS.CLIPBOARD_SANITIZED_WRITE)).toBe(true);
    });

    test('should support per-window policies', () => {
      const windowId = 1;
      
      handler.setWindowPolicy(windowId, {
        [PERMISSIONS.GEOLOCATION]: true, // Override for this window
      });
      
      expect(handler.isAllowed(PERMISSIONS.GEOLOCATION, windowId)).toBe(true);
      expect(handler.isAllowed(PERMISSIONS.GEOLOCATION)).toBe(false); // Still blocked globally
    });

    test('should allow/deny permissions dynamically', () => {
      handler.deny(PERMISSIONS.MEDIA);
      expect(handler.isAllowed(PERMISSIONS.MEDIA)).toBe(false);
      
      handler.allow(PERMISSIONS.MEDIA);
      expect(handler.isAllowed(PERMISSIONS.MEDIA)).toBe(true);
    });

    test('should get global policy', () => {
      const policy = handler.getGlobalPolicy();
      
      expect(policy).toBeDefined();
      expect(typeof policy).toBe('object');
      expect(policy[PERMISSIONS.MEDIA]).toBeDefined();
    });

    test('should get window policy', () => {
      const windowId = 1;
      
      handler.setWindowPolicy(windowId, {
        [PERMISSIONS.NOTIFICATIONS]: true,
      });
      
      const policy = handler.getWindowPolicy(windowId);
      expect(policy[PERMISSIONS.NOTIFICATIONS]).toBe(true);
    });

    test('should reset to default policy', () => {
      handler.allow(PERMISSIONS.USB);
      expect(handler.isAllowed(PERMISSIONS.USB)).toBe(true);
      
      handler.resetToDefault();
      expect(handler.isAllowed(PERMISSIONS.USB)).toBe(false);
    });
  });

  describe('Rate Limiting', () => {
    let rateLimiter;

    beforeEach(() => {
      rateLimiter = new RateLimiter({
        windowMs: 1000, // 1 second
        maxRequests: 5,
      });
    });

    test('should allow requests within limit', () => {
      const key = 'test-key';
      
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.checkLimit(key)).toBe(true);
      }
    });

    test('should block requests exceeding limit', () => {
      const key = 'test-key';
      
      // Use up the limit
      for (let i = 0; i < 5; i++) {
        rateLimiter.checkLimit(key);
      }
      
      // Next request should be blocked
      expect(rateLimiter.checkLimit(key)).toBe(false);
    });

    test('should reset after time window', async () => {
      const key = 'test-key';
      
      // Use up the limit
      for (let i = 0; i < 5; i++) {
        rateLimiter.checkLimit(key);
      }
      
      expect(rateLimiter.checkLimit(key)).toBe(false);
      
      // Wait for window to reset
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Should allow requests again
      expect(rateLimiter.checkLimit(key)).toBe(true);
    });

    test('should track different keys independently', () => {
      expect(rateLimiter.checkLimit('key-1')).toBe(true);
      expect(rateLimiter.checkLimit('key-2')).toBe(true);
      expect(rateLimiter.checkLimit('key-1')).toBe(true);
      expect(rateLimiter.checkLimit('key-2')).toBe(true);
    });
  });

  describe('Input Validation', () => {
    let validator;

    beforeEach(() => {
      validator = new InputValidator();
    });

    test('should validate required fields', () => {
      const result = validator.validate({}, {
        name: { required: true },
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBeDefined();
    });

    test('should validate field types', () => {
      const result = validator.validate({
        age: 'not-a-number',
      }, {
        age: { type: 'number' },
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.age).toBeDefined();
    });

    test('should validate string length', () => {
      const result = validator.validate({
        username: 'ab',
      }, {
        username: { type: 'string', minLength: 3, maxLength: 20 },
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.username).toBeDefined();
    });

    test('should validate number range', () => {
      const result = validator.validate({
        age: 200,
      }, {
        age: { type: 'number', min: 0, max: 150 },
      });
      
      expect(result.valid).toBe(false);
      expect(result.errors.age).toBeDefined();
    });

    test('should validate email format', () => {
      const validEmails = ['test@example.com', 'user+tag@domain.co.uk'];
      const invalidEmails = ['invalid', 'invalid@', '@invalid.com'];
      
      for (const email of validEmails) {
        const result = validator.validate({ email }, {
          email: { type: 'email' },
        });
        expect(result.valid).toBe(true);
      }
      
      for (const email of invalidEmails) {
        const result = validator.validate({ email }, {
          email: { type: 'email' },
        });
        expect(result.valid).toBe(false);
      }
    });

    test('should validate URL format', () => {
      const validUrls = ['https://example.com', 'http://localhost:3000'];
      const invalidUrls = ['not-a-url', 'ftp://invalid'];
      
      for (const url of validUrls) {
        const result = validator.validate({ url }, {
          url: { type: 'url' },
        });
        expect(result.valid).toBe(true);
      }
      
      for (const url of invalidUrls) {
        const result = validator.validate({ url }, {
          url: { type: 'url' },
        });
        expect(result.valid).toBe(false);
      }
    });
  });

  describe('End-to-End Security Validation', () => {
    test('should pass Phase 11 requirements', () => {
      const securityManager = new SecurityManager({
        mode: 'strict',
      });

      // 1. CSP enabled
      expect(securityManager.cspManager).toBeDefined();
      expect(securityManager.cspManager.enabled).toBe(true);

      // 2. Sandbox enforced
      const prefs = securityManager.getSecurePreferences();
      expect(prefs.sandbox).toBe(true);
      expect(prefs.contextIsolation).toBe(true);
      expect(prefs.nodeIntegration).toBe(false);

      // 3. Content sanitization available
      const sanitizer = new Sanitizer();
      expect(sanitizer).toBeDefined();

      // 4. External link protection available
      expect(securityManager.externalLinkHandler).toBeDefined();

      // 5. Permission management available
      expect(securityManager.permissionHandler).toBeDefined();

      // 6. Security audit available
      const audit = securityManager.audit();
      expect(audit).toBeDefined();
      expect(audit.recommendations).toBeDefined();

      // 7. No critical security issues
      const criticalIssues = audit.recommendations.filter(
        r => r.severity === 'critical'
      );
      expect(criticalIssues.length).toBe(0);
    });
  });
});


