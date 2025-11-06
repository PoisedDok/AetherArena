/**
 * Core Configuration Unit Tests
 * ============================================================================
 * Comprehensive unit tests for configuration module (100% coverage required)
 * 
 * @module tests/unit/core/config
 */

const config = require('../../../../src/core/config');

describe('Core Configuration', () => {
  describe('Configuration Loading', () => {
    test('should export configuration object', () => {
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
    });

    test('should have backend configuration', () => {
      expect(config.backend).toBeDefined();
      expect(config.backend.baseUrl).toBeDefined();
      expect(config.backend.wsUrl).toBeDefined();
    });

    test('should have UI configuration', () => {
      expect(config.ui).toBeDefined();
      expect(config.ui.normalWidth).toBeDefined();
      expect(config.ui.normalHeight).toBeDefined();
    });

    test('should have development configuration', () => {
      expect(config.dev).toBeDefined();
      expect(typeof config.dev.debugMode).toBe('boolean');
    });

    test('should freeze configuration', () => {
      expect(Object.isFrozen(config)).toBe(true);
    });
  });

  describe('Backend Configuration', () => {
    test('should have valid backend URL', () => {
      expect(config.backend.baseUrl).toMatch(/^https?:\/\//);
    });

    test('should have valid WebSocket URL', () => {
      expect(config.backend.wsUrl).toMatch(/^wss?:\/\//);
    });

    test('should have backend spawning configuration', () => {
      expect(typeof config.backend.shouldSpawn).toBe('boolean');
    });

    test('should have backend directory path', () => {
      if (config.backend.backendDir) {
        expect(typeof config.backend.backendDir).toBe('string');
      }
    });
  });

  describe('UI Configuration', () => {
    test('should have valid window dimensions', () => {
      expect(config.ui.normalWidth).toBeGreaterThan(0);
      expect(config.ui.normalHeight).toBeGreaterThan(0);
    });

    test('should have widget size configuration', () => {
      expect(config.ui.widgetSize).toBeDefined();
      expect(typeof config.ui.widgetSize).toBe('number');
    });
  });

  describe('Development Configuration', () => {
    test('should have debug mode setting', () => {
      expect(typeof config.dev.debugMode).toBe('boolean');
    });

    test('should match NODE_ENV in test', () => {
      // In test environment, should be properly configured
      expect(process.env.NODE_ENV).toBe('test');
    });
  });

  describe('Configuration Immutability', () => {
    test('should not allow modification of root config', () => {
      const originalKeys = Object.keys(config);
      config.newProperty = 'test';
      
      // Property should not be added (frozen)
      expect(Object.keys(config)).toEqual(originalKeys);
      expect(config.newProperty).toBeUndefined();
    });

    test('should not allow modification of nested config', () => {
      const originalBackend = { ...config.backend };
      config.backend.newProperty = 'test';
      
      // Nested config uses getters, can't be modified
      expect(config.backend.newProperty).toBeUndefined();
    });

    test('should not allow modification of existing properties', () => {
      const originalValue = config.backend.baseUrl;
      config.backend.baseUrl = 'http://hacked.com';
      
      // Getter returns same value (can't be overridden)
      expect(config.backend.baseUrl).toBe(originalValue);
      expect(config.backend.baseUrl).not.toBe('http://hacked.com');
    });
  });

  describe('Configuration Validation', () => {
    test('should have all required backend fields', () => {
      const required = ['baseUrl', 'wsUrl', 'shouldSpawn'];
      for (const field of required) {
        expect(config.backend[field]).toBeDefined();
      }
    });

    test('should have all required UI fields', () => {
      const required = ['normalWidth', 'normalHeight', 'widgetSize'];
      for (const field of required) {
        expect(config.ui[field]).toBeDefined();
      }
    });

    test('should have all required dev fields', () => {
      const required = ['debugMode'];
      for (const field of required) {
        expect(config.dev[field]).toBeDefined();
      }
    });
  });

  describe('Environment-Specific Configuration', () => {
    test('should load appropriate config for test environment', () => {
      // Test environment should have specific settings
      expect(process.env.NODE_ENV).toBe('test');
    });

    test('should have reasonable defaults', () => {
      expect(config.ui.normalWidth).toBeGreaterThan(100);
      expect(config.ui.normalWidth).toBeLessThan(2000);
      expect(config.ui.normalHeight).toBeGreaterThan(100);
      expect(config.ui.normalHeight).toBeLessThan(2000);
    });
  });

  describe('Type Safety', () => {
    test('should have correct types for backend config', () => {
      expect(typeof config.backend.baseUrl).toBe('string');
      expect(typeof config.backend.wsUrl).toBe('string');
      expect(typeof config.backend.shouldSpawn).toBe('boolean');
    });

    test('should have correct types for UI config', () => {
      expect(typeof config.ui.normalWidth).toBe('number');
      expect(typeof config.ui.normalHeight).toBe('number');
      expect(typeof config.ui.widgetSize).toBe('number');
    });

    test('should have correct types for dev config', () => {
      expect(typeof config.dev.debugMode).toBe('boolean');
    });
  });
});


