'use strict';

/**
 * Config Module Real Tests
 * Tests the actual configuration system with real values and validation
 */

// Fail-fast contract: backend URL must be provided via env or localStorage.
// Unit tests run in Node without desktop bootstrap, so set a deterministic value here.
process.env.GURU_API_URL = process.env.GURU_API_URL || 'http://127.0.0.1:8765';

const config = require('../../../src/core/config');

describe('Core Config Module', () => {
  describe('Backend Configuration', () => {
    it('should provide baseUrl', () => {
      expect(config.backend.baseUrl).toBeDefined();
      expect(typeof config.backend.baseUrl).toBe('string');
      expect(config.backend.baseUrl).toMatch(/^https?:\/\//);
    });

    it('should derive wsUrl from baseUrl', () => {
      expect(config.backend.wsUrl).toBeDefined();
      expect(typeof config.backend.wsUrl).toBe('string');
      expect(config.backend.wsUrl).toMatch(/^wss?:\/\//);
    });

    it('should provide shouldSpawn boolean', () => {
      expect(typeof config.backend.shouldSpawn).toBe('boolean');
    });

    it('should provide backendDir or null', () => {
      const backendDir = config.backend.backendDir;
      expect(backendDir === null || typeof backendDir === 'string').toBe(true);
    });

    it('should provide numeric healthCheckInterval', () => {
      expect(typeof config.backend.healthCheckInterval).toBe('number');
      expect(config.backend.healthCheckInterval).toBeGreaterThan(0);
    });
  });

  describe('Services/LLM Configuration (Removed)', () => {
    it('should not expose service URLs (fetched from backend /v1/settings)', () => {
      expect(config.services).toBeUndefined();
    });

    it('should not expose LLM provider config (fetched from backend /v1/settings)', () => {
      expect(config.llm).toBeUndefined();
    });
  });

  describe('Security Configuration', () => {
    it('should provide maxMessageSize', () => {
      expect(typeof config.security.maxMessageSize).toBe('number');
      expect(config.security.maxMessageSize).toBeGreaterThan(1000);
    });

    it('should provide rate limiting config', () => {
      expect(typeof config.security.maxMessagesPerMinute).toBe('number');
      expect(config.security.ipcRateLimitWindow).toBeGreaterThan(0);
      expect(config.security.ipcMaxCallsPerWindow).toBeGreaterThan(0);
    });

    it('should provide sanitizer profile', () => {
      expect(['strict', 'default', 'permissive']).toContain(config.security.sanitizerProfile);
    });
  });

  describe('Storage Configuration', () => {
    it('should provide backend type', () => {
      expect(['postgresql', 'sqlite', 'memory']).toContain(config.storage.backend);
    });

    it('should provide DOM management settings', () => {
      expect(typeof config.storage.maxDomMessages).toBe('number');
      expect(typeof config.storage.pruneBatchSize).toBe('number');
    });
  });

  describe('Endpoints', () => {
    const requiredEndpoints = [
      'health',
      'settings',
      'models',
      'modelCapabilities',
      'profiles',
      'stopGeneration',
      'chatStorage',
      'storageApi'
    ];

    requiredEndpoints.forEach(endpoint => {
      it(`should provide ${endpoint} endpoint`, () => {
        expect(config.endpoints[endpoint]).toBeDefined();
        expect(typeof config.endpoints[endpoint]).toBe('string');
        expect(config.endpoints[endpoint]).toMatch(/^\//);
      });
    });
  });

  describe('Feature Flags', () => {
    it('should provide voiceInput flag', () => {
      expect(typeof config.features.voiceInput).toBe('boolean');
    });

    it('should provide tts flag', () => {
      expect(typeof config.features.tts).toBe('boolean');
    });

    it('should provide offlineMode flag', () => {
      expect(typeof config.features.offlineMode).toBe('boolean');
    });
  });

  describe('Utility Functions', () => {
    it('should provide getBackendUrl function', () => {
      expect(typeof config.getBackendUrl).toBe('function');
    });

    it('getBackendUrl should construct valid URLs', () => {
      const healthUrl = config.getBackendUrl('health');
      expect(healthUrl).toContain(config.backend.baseUrl);
      expect(healthUrl).toContain('/health');
    });

    it('should provide getConfigSnapshot function', () => {
      expect(typeof config.getConfigSnapshot).toBe('function');
      const snapshot = config.getConfigSnapshot();
      expect(snapshot).toHaveProperty('backend');
      expect(snapshot).toHaveProperty('features');
    });
  });

  describe('Immutability', () => {
    it('should have frozen top-level config', () => {
      expect(() => {
        config.newProperty = 'test';
      }).toThrow();
    });

    it('should have frozen nested config objects', () => {
      expect(() => {
        config.backend.newProperty = 'test';
      }).toThrow();
    });
  });
});

