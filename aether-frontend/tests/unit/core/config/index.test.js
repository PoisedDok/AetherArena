/**
 * Core Configuration Unit Tests
 * ============================================================================
 * Comprehensive unit tests for configuration module (100% coverage required)
 * 
 * @module tests/unit/core/config
 */

// Fail-fast contract: backend URL must be provided via env or localStorage.
// Unit tests run in Node without desktop bootstrap, so set a deterministic value here.
process.env.GURU_API_URL = process.env.GURU_API_URL || 'http://127.0.0.1:8765';

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

  // =========================================================================
  // Backend — remaining getters
  // =========================================================================

  describe('Backend — extended getters', () => {
    test('healthCheckInterval returns number', () => {
      expect(typeof config.backend.healthCheckInterval).toBe('number');
      expect(config.backend.healthCheckInterval).toBeGreaterThan(0);
    });

    test('startupTimeout returns number', () => {
      expect(typeof config.backend.startupTimeout).toBe('number');
      expect(config.backend.startupTimeout).toBeGreaterThan(0);
    });

    test('connectInitialDelay returns number', () => {
      expect(typeof config.backend.connectInitialDelay).toBe('number');
    });

    test('connectMaxDelay returns number', () => {
      expect(typeof config.backend.connectMaxDelay).toBe('number');
    });

    test('connectMaxAttempts returns number', () => {
      expect(typeof config.backend.connectMaxAttempts).toBe('number');
      expect(config.backend.connectMaxAttempts).toBeGreaterThanOrEqual(1);
    });

    test('connectSuccessHideDelay returns number', () => {
      expect(typeof config.backend.connectSuccessHideDelay).toBe('number');
    });

    test('entryScript returns string or default', () => {
      const val = config.backend.entryScript;
      // Could be string from env or default
      expect(val === null || typeof val === 'string').toBe(true);
    });
  });

  // =========================================================================
  // UI — extended getters
  // =========================================================================

  describe('UI — extended getters', () => {
    test('widgetMargin returns number', () => {
      expect(typeof config.ui.widgetMargin).toBe('number');
    });

    test('updateInterval returns number', () => {
      expect(typeof config.ui.updateInterval).toBe('number');
    });

    test('animationDuration returns number', () => {
      expect(typeof config.ui.animationDuration).toBe('number');
    });

    test('mainWindowBackgroundColor returns string', () => {
      expect(typeof config.ui.mainWindowBackgroundColor).toBe('string');
    });

    test('chatWindowBackgroundColor returns string', () => {
      expect(typeof config.ui.chatWindowBackgroundColor).toBe('string');
    });

    test('artifactsWindowBackgroundColor returns string', () => {
      expect(typeof config.ui.artifactsWindowBackgroundColor).toBe('string');
    });

    test('enableNativeWindowEffects returns boolean', () => {
      expect(typeof config.ui.enableNativeWindowEffects).toBe('boolean');
    });

    test('macVibrancy returns string', () => {
      expect(typeof config.ui.macVibrancy).toBe('string');
    });

    test('macVisualEffectState returns string', () => {
      expect(typeof config.ui.macVisualEffectState).toBe('string');
    });

    test('windowsBackgroundMaterial returns string', () => {
      expect(typeof config.ui.windowsBackgroundMaterial).toBe('string');
    });

    test('disableNativeWindowEffectsInWidgetMode returns boolean', () => {
      expect(typeof config.ui.disableNativeWindowEffectsInWidgetMode).toBe('boolean');
    });

    test('startupAnimationEnabled returns boolean', () => {
      expect(typeof config.ui.startupAnimationEnabled).toBe('boolean');
    });

    test('startupMinDurationMs returns number', () => {
      expect(typeof config.ui.startupMinDurationMs).toBe('number');
    });

    test('startupSeparationDelayMs returns number', () => {
      expect(typeof config.ui.startupSeparationDelayMs).toBe('number');
    });

    test('startupExpandDelayMs returns number', () => {
      expect(typeof config.ui.startupExpandDelayMs).toBe('number');
    });

    test('startupFadeOutDurationMs returns number', () => {
      expect(typeof config.ui.startupFadeOutDurationMs).toBe('number');
    });

    test('startupHoldAfterExpandMs returns number', () => {
      expect(typeof config.ui.startupHoldAfterExpandMs).toBe('number');
    });
  });

  // =========================================================================
  // WebSocket
  // =========================================================================

  describe('WebSocket Configuration', () => {
    test('reconnectDelay returns number', () => {
      expect(typeof config.websocket.reconnectDelay).toBe('number');
      expect(config.websocket.reconnectDelay).toBeGreaterThan(0);
    });

    test('reconnectBackoffMax returns number', () => {
      expect(typeof config.websocket.reconnectBackoffMax).toBe('number');
    });

    test('pingInterval returns number', () => {
      expect(typeof config.websocket.pingInterval).toBe('number');
    });

    test('pongTimeout returns number', () => {
      expect(typeof config.websocket.pongTimeout).toBe('number');
    });

    test('websocket config is frozen', () => {
      expect(Object.isFrozen(config.websocket)).toBe(true);
    });
  });

  // =========================================================================
  // API
  // =========================================================================

  describe('API Configuration', () => {
    test('timeout returns number', () => {
      expect(typeof config.api.timeout).toBe('number');
      expect(config.api.timeout).toBeGreaterThan(0);
    });

    test('retries returns number', () => {
      expect(typeof config.api.retries).toBe('number');
      expect(config.api.retries).toBeGreaterThanOrEqual(0);
    });

    test('retryDelay returns number', () => {
      expect(typeof config.api.retryDelay).toBe('number');
    });

    test('maxPayloadSize returns number', () => {
      expect(typeof config.api.maxPayloadSize).toBe('number');
      expect(config.api.maxPayloadSize).toBeGreaterThan(0);
    });

    test('api config is frozen', () => {
      expect(Object.isFrozen(config.api)).toBe(true);
    });
  });

  // =========================================================================
  // Security
  // =========================================================================

  describe('Security Configuration', () => {
    test('maxMessageSize returns number', () => {
      expect(typeof config.security.maxMessageSize).toBe('number');
      expect(config.security.maxMessageSize).toBeGreaterThan(0);
    });

    test('maxMessagesPerMinute returns number', () => {
      expect(typeof config.security.maxMessagesPerMinute).toBe('number');
    });

    test('ipcRateLimitWindow returns number', () => {
      expect(typeof config.security.ipcRateLimitWindow).toBe('number');
    });

    test('ipcMaxCallsPerWindow returns number', () => {
      expect(typeof config.security.ipcMaxCallsPerWindow).toBe('number');
    });

    test('maxFileSizeMB returns number', () => {
      expect(typeof config.security.maxFileSizeMB).toBe('number');
    });

    test('maxPayloadSizeMB returns number', () => {
      expect(typeof config.security.maxPayloadSizeMB).toBe('number');
    });

    test('sanitizerProfile returns string', () => {
      expect(typeof config.security.sanitizerProfile).toBe('string');
    });

    test('security config is frozen', () => {
      expect(Object.isFrozen(config.security)).toBe(true);
    });
  });

  // =========================================================================
  // Storage
  // =========================================================================

  describe('Storage Configuration', () => {
    test('backend returns string', () => {
      expect(typeof config.storage.backend).toBe('string');
    });

    test('maxDomMessages returns number', () => {
      expect(typeof config.storage.maxDomMessages).toBe('number');
    });

    test('pruneBatchSize returns number', () => {
      expect(typeof config.storage.pruneBatchSize).toBe('number');
    });

    test('gracePeriodMs returns number', () => {
      expect(typeof config.storage.gracePeriodMs).toBe('number');
    });

    test('bufferSize returns number', () => {
      expect(typeof config.storage.bufferSize).toBe('number');
    });

    test('storage config is frozen', () => {
      expect(Object.isFrozen(config.storage)).toBe(true);
    });
  });

  // =========================================================================
  // Artifacts
  // =========================================================================

  describe('Artifacts Configuration', () => {
    test('fetchTimeout returns number', () => {
      expect(typeof config.artifacts.fetchTimeout).toBe('number');
    });

    test('saveTimeout returns number', () => {
      expect(typeof config.artifacts.saveTimeout).toBe('number');
    });

    test('maxArtifactSize returns number', () => {
      expect(typeof config.artifacts.maxArtifactSize).toBe('number');
      expect(config.artifacts.maxArtifactSize).toBeGreaterThan(0);
    });

    test('artifacts config is frozen', () => {
      expect(Object.isFrozen(config.artifacts)).toBe(true);
    });
  });

  // =========================================================================
  // Logging
  // =========================================================================

  describe('Logging Configuration', () => {
    test('level returns string', () => {
      expect(typeof config.logging.level).toBe('string');
    });

    test('maxFileSize returns number', () => {
      expect(typeof config.logging.maxFileSize).toBe('number');
    });

    test('maxFiles returns number', () => {
      expect(typeof config.logging.maxFiles).toBe('number');
    });

    test('console returns boolean', () => {
      expect(typeof config.logging.console).toBe('boolean');
    });

    test('file returns boolean', () => {
      expect(typeof config.logging.file).toBe('boolean');
    });

    test('logging config is frozen', () => {
      expect(Object.isFrozen(config.logging)).toBe(true);
    });
  });

  // =========================================================================
  // Features
  // =========================================================================

  describe('Features Configuration', () => {
    test('voiceInput returns boolean', () => {
      expect(typeof config.features.voiceInput).toBe('boolean');
    });

    test('tts returns boolean', () => {
      expect(typeof config.features.tts).toBe('boolean');
    });

    test('legalNews returns boolean', () => {
      expect(typeof config.features.legalNews).toBe('boolean');
    });

    test('artifactsStream returns boolean', () => {
      expect(typeof config.features.artifactsStream).toBe('boolean');
    });

    test('diagnostics returns boolean', () => {
      expect(typeof config.features.diagnostics).toBe('boolean');
    });

    test('offlineMode returns boolean', () => {
      expect(typeof config.features.offlineMode).toBe('boolean');
    });

    test('features config is frozen', () => {
      expect(Object.isFrozen(config.features)).toBe(true);
    });
  });

  // =========================================================================
  // Dev — extended getters
  // =========================================================================

  describe('Dev — extended getters', () => {
    test('mockBackend returns boolean', () => {
      expect(typeof config.dev.mockBackend).toBe('boolean');
    });

    test('verboseLogging returns boolean', () => {
      expect(typeof config.dev.verboseLogging).toBe('boolean');
    });

    test('skipHealthCheck returns boolean', () => {
      expect(typeof config.dev.skipHealthCheck).toBe('boolean');
    });

    test('openDevToolsMain returns boolean', () => {
      expect(typeof config.dev.openDevToolsMain).toBe('boolean');
    });

    test('openDevToolsAux returns boolean', () => {
      expect(typeof config.dev.openDevToolsAux).toBe('boolean');
    });

    test('dev config is frozen', () => {
      expect(Object.isFrozen(config.dev)).toBe(true);
    });
  });

  // =========================================================================
  // Endpoints / Paths
  // =========================================================================

  describe('Endpoints and Paths', () => {
    test('endpoints is a frozen object', () => {
      expect(Object.isFrozen(config.endpoints)).toBe(true);
      expect(typeof config.endpoints).toBe('object');
    });

    test('paths is a frozen object', () => {
      expect(Object.isFrozen(config.paths)).toBe(true);
      expect(typeof config.paths).toBe('object');
    });
  });

  // =========================================================================
  // Utility functions
  // =========================================================================

  describe('getBackendUrl()', () => {
    test('resolves known endpoint to full URL', () => {
      // endpoints should have at least one key
      const keys = Object.keys(config.endpoints);
      expect(keys.length).toBeGreaterThan(0);

      const url = config.getBackendUrl(keys[0]);
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^https?:\/\//);
    });

    test('throws for unknown endpoint', () => {
      expect(() => config.getBackendUrl('NONEXISTENT_ENDPOINT')).toThrow('Unknown endpoint');
    });
  });

  describe('getConfigSnapshot()', () => {
    test('returns non-null object', () => {
      const snapshot = config.getConfigSnapshot();
      expect(snapshot).not.toBeNull();
      expect(typeof snapshot).toBe('object');
    });

    test('snapshot has backend section', () => {
      const snapshot = config.getConfigSnapshot();
      expect(snapshot.backend).toBeDefined();
      expect(snapshot.backend.baseUrl).toBeDefined();
      expect(snapshot.backend.wsUrl).toBeDefined();
      expect(typeof snapshot.backend.shouldSpawn).toBe('boolean');
    });

    test('snapshot has ui section with startup animation', () => {
      const snapshot = config.getConfigSnapshot();
      expect(snapshot.ui).toBeDefined();
      expect(snapshot.ui.widgetSize).toBeDefined();
      expect(snapshot.ui.startupAnimation).toBeDefined();
      expect(typeof snapshot.ui.startupAnimation.enabled).toBe('boolean');
    });

    test('snapshot has features section', () => {
      const snapshot = config.getConfigSnapshot();
      expect(snapshot.features).toBeDefined();
      expect(typeof snapshot.features.voiceInput).toBe('boolean');
    });

    test('snapshot has dev section', () => {
      const snapshot = config.getConfigSnapshot();
      expect(snapshot.dev).toBeDefined();
      expect(typeof snapshot.dev.debugMode).toBe('boolean');
    });
  });

  describe('reloadConfig()', () => {
    test('executes without error', () => {
      expect(() => config.reloadConfig()).not.toThrow();
    });
  });

  // =========================================================================
  // Exported utilities
  // =========================================================================

  describe('Exported utilities', () => {
    test('envLoader is exported', () => {
      expect(config.envLoader).toBeDefined();
    });

    test('isValidUrl is a function', () => {
      expect(typeof config.isValidUrl).toBe('function');
    });

    test('normalizeUrl is a function', () => {
      expect(typeof config.normalizeUrl).toBe('function');
    });
  });
});
