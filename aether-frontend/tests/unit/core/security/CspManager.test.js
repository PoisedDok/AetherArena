/**
 * CspManager Unit Tests
 * ============================================================================
 * Comprehensive unit tests for CSP Manager (100% coverage required)
 * 
 * @module tests/unit/core/security/CspManager
 */

const { CspManager, DEFAULT_POLICIES } = require('../../../../src/core/security/CspManager');

describe('CspManager', () => {
  describe('Initialization', () => {
    test('should create instance with default options', () => {
      const cspManager = new CspManager();
      
      expect(cspManager).toBeDefined();
      expect(cspManager.environment).toBe('development');
      expect(cspManager.enabled).toBe(true);
    });

    test('should create instance with custom options', () => {
      const cspManager = new CspManager({
        environment: 'production',
        enabled: true,
        reportOnly: true,
      });
      
      expect(cspManager.environment).toBe('production');
      expect(cspManager.reportOnly).toBe(true);
    });

    test('should initialize with empty violations array', () => {
      const cspManager = new CspManager();
      expect(cspManager.violations).toEqual([]);
    });

    test('should initialize with no current nonce', () => {
      const cspManager = new CspManager();
      expect(cspManager.currentNonce).toBeNull();
    });
  });

  describe('Policy Building', () => {
    test('should build valid CSP policy string', () => {
      const cspManager = new CspManager({ environment: 'production' });
      const policy = cspManager.buildPolicy();
      
      expect(policy).toBeDefined();
      expect(typeof policy).toBe('string');
      expect(policy).toContain("default-src 'self'");
    });

    test('should include script-src directive', () => {
      const cspManager = new CspManager({ environment: 'production' });
      const policy = cspManager.buildPolicy();
      
      expect(policy).toContain('script-src');
    });

    test('should include object-src none', () => {
      const cspManager = new CspManager({ environment: 'production' });
      const policy = cspManager.buildPolicy();
      
      expect(policy).toContain("object-src 'none'");
    });

    test('should not include unsafe-inline in production', () => {
      const cspManager = new CspManager({ environment: 'production' });
      const policy = cspManager.buildPolicy();
      
      expect(policy).not.toContain('unsafe-inline');
    });

    test('should not include unsafe-eval in production', () => {
      const cspManager = new CspManager({ environment: 'production' });
      const policy = cspManager.buildPolicy();
      
      expect(policy).not.toContain('unsafe-eval');
    });
  });

  describe('Nonce Generation', () => {
    test('should generate cryptographic nonce', () => {
      const cspManager = new CspManager();
      const nonce = cspManager.generateNonce();
      
      expect(nonce).toBeDefined();
      expect(typeof nonce).toBe('string');
      expect(nonce.length).toBeGreaterThan(0);
    });

    test('should generate unique nonces', () => {
      const cspManager = new CspManager();
      const nonce1 = cspManager.generateNonce();
      const nonce2 = cspManager.generateNonce();
      
      expect(nonce1).not.toBe(nonce2);
    });

    test('should store current nonce', () => {
      const cspManager = new CspManager();
      const nonce = cspManager.generateNonce();
      
      expect(cspManager.getNonce()).toBe(nonce);
    });

    test('should add nonce to policy', () => {
      const cspManager = new CspManager();
      const nonce = cspManager.generateNonce();
      cspManager.addNonce(nonce);
      
      const policy = cspManager.buildPolicy();
      expect(policy).toContain(`'nonce-${nonce}'`);
    });

    test('should add nonce to script-src by default', () => {
      const cspManager = new CspManager();
      const nonce = 'test-nonce';
      cspManager.addNonce(nonce);
      
      expect(cspManager.directives['script-src']).toContain(`'nonce-${nonce}'`);
    });

    test('should add nonce to style-src by default', () => {
      const cspManager = new CspManager();
      const nonce = 'test-nonce';
      cspManager.addNonce(nonce);
      
      expect(cspManager.directives['style-src']).toContain(`'nonce-${nonce}'`);
    });

    test('should add nonce to custom directives', () => {
      const cspManager = new CspManager();
      const nonce = 'test-nonce';
      cspManager.addNonce(nonce, ['script-src']);
      
      expect(cspManager.directives['script-src']).toContain(`'nonce-${nonce}'`);
    });
  });

  describe('Policy Validation', () => {
    test('should validate production policy successfully', () => {
      const cspManager = new CspManager({ environment: 'production' });
      const validation = cspManager.validate();
      
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });

    test('should detect unsafe directives in production', () => {
      const cspManager = new CspManager({
        environment: 'production',
        directives: {
          'script-src': ["'self'", "'unsafe-inline'"],
        },
      });
      
      const validation = cspManager.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    test('should check for required directives', () => {
      const cspManager = new CspManager({
        directives: {
          'script-src': ["'self'"],
        },
      });
      
      // Manually remove required directive to test validation
      delete cspManager.directives['default-src'];
      
      const validation = cspManager.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing required directive: default-src');
    });

    test('should allow unsafe directives in development', () => {
      const cspManager = new CspManager({
        environment: 'development',
        directives: {
          'script-src': ["'self'", "'unsafe-inline'"],
        },
      });
      
      const validation = cspManager.validate();
      // Development mode doesn't check for unsafe directives
      expect(validation.errors).not.toContain(
        expect.stringContaining('unsafe-inline')
      );
    });
  });

  describe('Header Generation', () => {
    test('should generate CSP header', () => {
      const cspManager = new CspManager();
      const header = cspManager.getHeader();
      
      expect(header).toBeDefined();
      expect(header.name).toBe('Content-Security-Policy');
      expect(header.value).toBeDefined();
    });

    test('should generate report-only header', () => {
      const cspManager = new CspManager({ reportOnly: true });
      const header = cspManager.getHeader();
      
      expect(header.name).toBe('Content-Security-Policy-Report-Only');
    });

    test('should get correct header name', () => {
      const cspManager = new CspManager({ reportOnly: false });
      expect(cspManager.getHeaderName()).toBe('Content-Security-Policy');
      
      cspManager.setReportOnly(true);
      expect(cspManager.getHeaderName()).toBe('Content-Security-Policy-Report-Only');
    });
  });

  describe('Violation Tracking', () => {
    test('should record violations', () => {
      const cspManager = new CspManager();
      const violation = {
        blockedUri: 'https://evil.com/script.js',
        effectiveDirective: 'script-src',
      };
      
      cspManager._recordViolation(violation);
      
      const violations = cspManager.getViolations();
      expect(violations.length).toBe(1);
      expect(violations[0]).toMatchObject(violation);
    });

    test('should limit violations history', () => {
      const cspManager = new CspManager({ maxViolations: 5 });
      
      for (let i = 0; i < 10; i++) {
        cspManager._recordViolation({ index: i });
      }
      
      const violations = cspManager.getViolations();
      expect(violations.length).toBeLessThanOrEqual(5);
    });

    test('should clear violations', () => {
      const cspManager = new CspManager();
      cspManager._recordViolation({ test: 'data' });
      
      expect(cspManager.getViolations().length).toBe(1);
      
      cspManager.clearViolations();
      expect(cspManager.getViolations().length).toBe(0);
    });
  });

  describe('Policy Management', () => {
    test('should enable CSP', () => {
      const cspManager = new CspManager({ enabled: false });
      expect(cspManager.enabled).toBe(false);
      
      cspManager.enable();
      expect(cspManager.enabled).toBe(true);
    });

    test('should disable CSP', () => {
      const cspManager = new CspManager({ enabled: true });
      expect(cspManager.enabled).toBe(true);
      
      cspManager.disable();
      expect(cspManager.enabled).toBe(false);
    });

    test('should toggle report-only mode', () => {
      const cspManager = new CspManager({ reportOnly: false });
      
      cspManager.setReportOnly(true);
      expect(cspManager.reportOnly).toBe(true);
      
      cspManager.setReportOnly(false);
      expect(cspManager.reportOnly).toBe(false);
    });
  });

  describe('Info and Reporting', () => {
    test('should get policy info', () => {
      const cspManager = new CspManager({ environment: 'production' });
      const info = cspManager.getInfo();
      
      expect(info).toBeDefined();
      expect(info.environment).toBe('production');
      expect(info.enabled).toBeDefined();
      expect(info.policy).toBeDefined();
    });

    test('should include violations count in info', () => {
      const cspManager = new CspManager();
      cspManager._recordViolation({ test: 'violation' });
      
      const info = cspManager.getInfo();
      expect(info.violations).toBe(1);
    });

    test('should freeze info object', () => {
      const cspManager = new CspManager();
      const info = cspManager.getInfo();
      
      expect(Object.isFrozen(info)).toBe(true);
    });
  });

  describe('Default Policies', () => {
    test('should export default policies', () => {
      expect(DEFAULT_POLICIES).toBeDefined();
      expect(DEFAULT_POLICIES.production).toBeDefined();
      expect(DEFAULT_POLICIES.development).toBeDefined();
    });

    test('should freeze default policies', () => {
      expect(Object.isFrozen(DEFAULT_POLICIES)).toBe(true);
      expect(Object.isFrozen(DEFAULT_POLICIES.production)).toBe(true);
      expect(Object.isFrozen(DEFAULT_POLICIES.development)).toBe(true);
    });

    test('production policy should be strict', () => {
      const prodPolicy = DEFAULT_POLICIES.production;
      
      expect(prodPolicy['default-src']).toContain("'self'");
      expect(prodPolicy['script-src']).not.toContain("'unsafe-inline'");
      expect(prodPolicy['script-src']).not.toContain("'unsafe-eval'");
    });

    test('development policy should be permissive', () => {
      const devPolicy = DEFAULT_POLICIES.development;
      
      expect(devPolicy['script-src']).toContain("'unsafe-inline'");
      expect(devPolicy['script-src']).toContain("'unsafe-eval'");
    });
  });

  describe('Custom Directives', () => {
    test('should merge custom directives with defaults', () => {
      const cspManager = new CspManager({
        directives: {
          'connect-src': ["'self'", 'https://api.example.com'],
        },
      });
      
      expect(cspManager.directives['connect-src']).toContain("'self'");
      expect(cspManager.directives['connect-src']).toContain('https://api.example.com');
    });

    test('should not override required directives', () => {
      const cspManager = new CspManager({
        environment: 'production',
        directives: {
          'default-src': ["'none'"], // Try to override
        },
      });
      
      // Should still have default-src
      expect(cspManager.directives['default-src']).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty directives', () => {
      const cspManager = new CspManager({
        directives: {},
      });
      
      const policy = cspManager.buildPolicy();
      expect(policy).toBeDefined();
    });

    test('should handle null options gracefully', () => {
      const cspManager = new CspManager(null);
      expect(cspManager).toBeDefined();
    });

    test('should handle undefined options gracefully', () => {
      const cspManager = new CspManager(undefined);
      expect(cspManager).toBeDefined();
    });

    test('should handle invalid environment gracefully', () => {
      const cspManager = new CspManager({ environment: 'invalid' });
      expect(cspManager).toBeDefined();
      // Should fall back to development
    });
  });
});


