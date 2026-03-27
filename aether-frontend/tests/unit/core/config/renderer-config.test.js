'use strict';

/**
 * renderer-config Unit Tests
 * ============================================================================
 * Tests default getter values, contract violations in backend.baseUrl,
 * safeGet* portResolver delegation, getBackendUrl, getConfigSnapshot,
 * reloadConfig, debug mode logging, and window global.
 *
 * @module tests/unit/core/config/renderer-config.test
 */

// Fail-fast contract: backend URL must be provided.
process.env.GURU_API_URL = process.env.GURU_API_URL || 'http://127.0.0.1:8765';

const rendererConfig = require('../../../../src/core/config/renderer-config');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderer-config', () => {
  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports a frozen object', () => {
      expect(Object.isFrozen(rendererConfig)).toBe(true);
    });

    it('exports getBackendUrl function', () => {
      expect(typeof rendererConfig.getBackendUrl).toBe('function');
    });

    it('exports getConfigSnapshot function', () => {
      expect(typeof rendererConfig.getConfigSnapshot).toBe('function');
    });

    it('exports reloadConfig function', () => {
      expect(typeof rendererConfig.reloadConfig).toBe('function');
    });

    it('exports envLoader', () => {
      expect(rendererConfig.envLoader).toBeDefined();
    });

    it('exports isValidUrl function', () => {
      expect(typeof rendererConfig.isValidUrl).toBe('function');
    });

    it('exports normalizeUrl function', () => {
      expect(typeof rendererConfig.normalizeUrl).toBe('function');
    });
  });

  // =========================================================================
  // backend
  // =========================================================================

  describe('backend', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.backend)).toBe(true);
    });

    it('baseUrl returns valid HTTP(S) URL', () => {
      expect(rendererConfig.backend.baseUrl).toMatch(/^https?:\/\//);
    });

    it('baseUrl does not have trailing slash', () => {
      expect(rendererConfig.backend.baseUrl).not.toMatch(/\/$/);
    });

    it('wsUrl returns valid WS(S) URL', () => {
      expect(rendererConfig.backend.wsUrl).toMatch(/^wss?:\/\//);
    });

    it('shouldSpawn returns boolean', () => {
      expect(typeof rendererConfig.backend.shouldSpawn).toBe('boolean');
    });

    it('healthCheckInterval returns positive number', () => {
      expect(rendererConfig.backend.healthCheckInterval).toBeGreaterThan(0);
    });

    it('startupTimeout returns positive number', () => {
      expect(rendererConfig.backend.startupTimeout).toBeGreaterThan(0);
    });

    it('connectInitialDelay returns positive number', () => {
      expect(rendererConfig.backend.connectInitialDelay).toBeGreaterThan(0);
    });

    it('connectMaxDelay returns positive number', () => {
      expect(rendererConfig.backend.connectMaxDelay).toBeGreaterThan(0);
    });

    it('connectMaxAttempts returns positive integer', () => {
      expect(rendererConfig.backend.connectMaxAttempts).toBeGreaterThanOrEqual(1);
    });

    it('connectSuccessHideDelay returns positive number', () => {
      expect(rendererConfig.backend.connectSuccessHideDelay).toBeGreaterThan(0);
    });

    it('backendDir returns string or null', () => {
      const dir = rendererConfig.backend.backendDir;
      expect(dir === null || typeof dir === 'string').toBe(true);
    });
  });

  // =========================================================================
  // ui
  // =========================================================================

  describe('ui', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.ui)).toBe(true);
    });

    it('widgetSize returns positive number', () => {
      expect(rendererConfig.ui.widgetSize).toBeGreaterThanOrEqual(100);
    });

    it('normalWidth returns positive number', () => {
      expect(rendererConfig.ui.normalWidth).toBeGreaterThanOrEqual(600);
    });

    it('normalHeight returns positive number', () => {
      expect(rendererConfig.ui.normalHeight).toBeGreaterThanOrEqual(400);
    });

    it('widgetMargin returns non-negative number', () => {
      expect(rendererConfig.ui.widgetMargin).toBeGreaterThanOrEqual(0);
    });

    it('updateInterval returns positive number', () => {
      expect(rendererConfig.ui.updateInterval).toBeGreaterThanOrEqual(16);
    });

    it('animationDuration returns positive number', () => {
      expect(rendererConfig.ui.animationDuration).toBeGreaterThanOrEqual(100);
    });

    it('mainWindowBackgroundColor returns string', () => {
      expect(typeof rendererConfig.ui.mainWindowBackgroundColor).toBe('string');
    });

    it('chatWindowBackgroundColor returns string', () => {
      expect(typeof rendererConfig.ui.chatWindowBackgroundColor).toBe('string');
    });

    it('artifactsWindowBackgroundColor returns string', () => {
      expect(typeof rendererConfig.ui.artifactsWindowBackgroundColor).toBe('string');
    });

    it('startupAnimationEnabled returns boolean', () => {
      expect(typeof rendererConfig.ui.startupAnimationEnabled).toBe('boolean');
    });

    it('startupMinDurationMs returns positive number', () => {
      expect(rendererConfig.ui.startupMinDurationMs).toBeGreaterThan(0);
    });

    it('startupSeparationDelayMs returns positive number', () => {
      expect(rendererConfig.ui.startupSeparationDelayMs).toBeGreaterThan(0);
    });

    it('startupExpandDelayMs returns positive number', () => {
      expect(rendererConfig.ui.startupExpandDelayMs).toBeGreaterThan(0);
    });

    it('startupFadeOutDurationMs returns positive number', () => {
      expect(rendererConfig.ui.startupFadeOutDurationMs).toBeGreaterThan(0);
    });

    it('startupHoldAfterExpandMs returns positive number', () => {
      expect(rendererConfig.ui.startupHoldAfterExpandMs).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // websocket
  // =========================================================================

  describe('websocket', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.websocket)).toBe(true);
    });

    it('reconnectDelay returns positive number', () => {
      expect(rendererConfig.websocket.reconnectDelay).toBeGreaterThan(0);
    });

    it('reconnectBackoffMax returns positive number', () => {
      expect(rendererConfig.websocket.reconnectBackoffMax).toBeGreaterThan(0);
    });

    it('pingInterval returns positive number', () => {
      expect(rendererConfig.websocket.pingInterval).toBeGreaterThan(0);
    });

    it('pongTimeout returns positive number', () => {
      expect(rendererConfig.websocket.pongTimeout).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // api
  // =========================================================================

  describe('api', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.api)).toBe(true);
    });

    it('timeout returns positive number', () => {
      expect(rendererConfig.api.timeout).toBeGreaterThan(0);
    });

    it('retries returns non-negative integer', () => {
      expect(rendererConfig.api.retries).toBeGreaterThanOrEqual(0);
    });

    it('retryDelay returns positive number', () => {
      expect(rendererConfig.api.retryDelay).toBeGreaterThan(0);
    });

    it('maxPayloadSize returns positive number', () => {
      expect(rendererConfig.api.maxPayloadSize).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // security
  // =========================================================================

  describe('security', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.security)).toBe(true);
    });

    it('maxMessageSize returns positive number', () => {
      expect(rendererConfig.security.maxMessageSize).toBeGreaterThan(0);
    });

    it('maxMessagesPerMinute returns positive number', () => {
      expect(rendererConfig.security.maxMessagesPerMinute).toBeGreaterThan(0);
    });

    it('ipcRateLimitWindow returns positive number', () => {
      expect(rendererConfig.security.ipcRateLimitWindow).toBeGreaterThan(0);
    });

    it('ipcMaxCallsPerWindow returns positive number', () => {
      expect(rendererConfig.security.ipcMaxCallsPerWindow).toBeGreaterThan(0);
    });

    it('maxFileSizeMB returns positive number', () => {
      expect(rendererConfig.security.maxFileSizeMB).toBeGreaterThan(0);
    });

    it('maxPayloadSizeMB returns positive number', () => {
      expect(rendererConfig.security.maxPayloadSizeMB).toBeGreaterThan(0);
    });

    it('sanitizerProfile returns valid string', () => {
      expect(['strict', 'default', 'permissive']).toContain(rendererConfig.security.sanitizerProfile);
    });
  });

  // =========================================================================
  // storage
  // =========================================================================

  describe('storage', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.storage)).toBe(true);
    });

    it('backend returns valid storage backend', () => {
      expect(typeof rendererConfig.storage.backend).toBe('string');
    });

    it('maxDomMessages returns positive number', () => {
      expect(rendererConfig.storage.maxDomMessages).toBeGreaterThan(0);
    });

    it('pruneBatchSize returns positive number', () => {
      expect(rendererConfig.storage.pruneBatchSize).toBeGreaterThan(0);
    });

    it('gracePeriodMs returns positive number', () => {
      expect(rendererConfig.storage.gracePeriodMs).toBeGreaterThan(0);
    });

    it('bufferSize returns positive number', () => {
      expect(rendererConfig.storage.bufferSize).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // artifacts
  // =========================================================================

  describe('artifacts', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.artifacts)).toBe(true);
    });

    it('fetchTimeout returns positive number', () => {
      expect(rendererConfig.artifacts.fetchTimeout).toBeGreaterThan(0);
    });

    it('saveTimeout returns positive number', () => {
      expect(rendererConfig.artifacts.saveTimeout).toBeGreaterThan(0);
    });

    it('maxArtifactSize returns positive number', () => {
      expect(rendererConfig.artifacts.maxArtifactSize).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // logging
  // =========================================================================

  describe('logging', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.logging)).toBe(true);
    });

    it('level returns valid log level string', () => {
      expect(['silent', 'error', 'warn', 'info', 'debug', 'trace']).toContain(rendererConfig.logging.level);
    });

    it('maxFileSize returns positive number', () => {
      expect(rendererConfig.logging.maxFileSize).toBeGreaterThan(0);
    });

    it('maxFiles returns positive number', () => {
      expect(rendererConfig.logging.maxFiles).toBeGreaterThanOrEqual(1);
    });

    it('console returns boolean', () => {
      expect(typeof rendererConfig.logging.console).toBe('boolean');
    });

    it('file returns boolean', () => {
      expect(typeof rendererConfig.logging.file).toBe('boolean');
    });
  });

  // =========================================================================
  // features
  // =========================================================================

  describe('features', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.features)).toBe(true);
    });

    it('voiceInput returns boolean', () => {
      expect(typeof rendererConfig.features.voiceInput).toBe('boolean');
    });

    it('tts returns boolean', () => {
      expect(typeof rendererConfig.features.tts).toBe('boolean');
    });

    it('legalNews returns boolean', () => {
      expect(typeof rendererConfig.features.legalNews).toBe('boolean');
    });

    it('artifactsStream returns boolean', () => {
      expect(typeof rendererConfig.features.artifactsStream).toBe('boolean');
    });

    it('diagnostics returns boolean', () => {
      expect(typeof rendererConfig.features.diagnostics).toBe('boolean');
    });

    it('offlineMode returns boolean', () => {
      expect(typeof rendererConfig.features.offlineMode).toBe('boolean');
    });
  });

  // =========================================================================
  // dev
  // =========================================================================

  describe('dev', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.dev)).toBe(true);
    });

    it('debugMode returns boolean', () => {
      expect(typeof rendererConfig.dev.debugMode).toBe('boolean');
    });

    it('mockBackend returns boolean', () => {
      expect(typeof rendererConfig.dev.mockBackend).toBe('boolean');
    });

    it('verboseLogging returns boolean', () => {
      expect(typeof rendererConfig.dev.verboseLogging).toBe('boolean');
    });

    it('skipHealthCheck returns boolean', () => {
      expect(typeof rendererConfig.dev.skipHealthCheck).toBe('boolean');
    });

    it('openDevToolsMain returns boolean', () => {
      expect(typeof rendererConfig.dev.openDevToolsMain).toBe('boolean');
    });

    it('openDevToolsAux returns boolean', () => {
      expect(typeof rendererConfig.dev.openDevToolsAux).toBe('boolean');
    });
  });

  // =========================================================================
  // endpoints & paths
  // =========================================================================

  describe('endpoints', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.endpoints)).toBe(true);
    });

    it('has health endpoint', () => {
      expect(rendererConfig.endpoints.health).toBe('/v1/health');
    });

    it('has settings endpoint', () => {
      expect(rendererConfig.endpoints.settings).toBe('/v1/settings/');
    });
  });

  describe('paths', () => {
    it('returns frozen object', () => {
      expect(Object.isFrozen(rendererConfig.paths)).toBe(true);
    });

    it('has skillsDir', () => {
      expect(typeof rendererConfig.paths.skillsDir).toBe('string');
    });
  });

  // =========================================================================
  // getBackendUrl
  // =========================================================================

  describe('getBackendUrl', () => {
    it('returns full URL for known endpoint', () => {
      const url = rendererConfig.getBackendUrl('health');
      expect(url).toMatch(/^https?:\/\/.+\/v1\/health$/);
    });

    it('throws for unknown endpoint', () => {
      expect(() => rendererConfig.getBackendUrl('nonexistent')).toThrow('Unknown endpoint');
    });
  });

  // =========================================================================
  // getConfigSnapshot
  // =========================================================================

  describe('getConfigSnapshot', () => {
    it('returns object with expected top-level keys', () => {
      const snap = rendererConfig.getConfigSnapshot();
      expect(snap).toHaveProperty('backend');
      expect(snap).toHaveProperty('ui');
      expect(snap).toHaveProperty('features');
      expect(snap).toHaveProperty('dev');
    });

    it('backend section has baseUrl, wsUrl, shouldSpawn', () => {
      const snap = rendererConfig.getConfigSnapshot();
      expect(snap.backend).toHaveProperty('baseUrl');
      expect(snap.backend).toHaveProperty('wsUrl');
      expect(snap.backend).toHaveProperty('shouldSpawn');
    });

    it('ui section has startupAnimation sub-object', () => {
      const snap = rendererConfig.getConfigSnapshot();
      expect(snap.ui).toHaveProperty('startupAnimation');
      expect(snap.ui.startupAnimation).toHaveProperty('enabled');
      expect(snap.ui.startupAnimation).toHaveProperty('minDurationMs');
    });

    it('features section has voiceInput, tts, offlineMode', () => {
      const snap = rendererConfig.getConfigSnapshot();
      expect(snap.features).toHaveProperty('voiceInput');
      expect(snap.features).toHaveProperty('tts');
      expect(snap.features).toHaveProperty('offlineMode');
    });

    it('dev section has all dev flags', () => {
      const snap = rendererConfig.getConfigSnapshot();
      expect(snap.dev).toHaveProperty('debugMode');
      expect(snap.dev).toHaveProperty('mockBackend');
      expect(snap.dev).toHaveProperty('skipHealthCheck');
      expect(snap.dev).toHaveProperty('openDevToolsMain');
      expect(snap.dev).toHaveProperty('openDevToolsAux');
    });
  });

  // =========================================================================
  // reloadConfig
  // =========================================================================

  describe('reloadConfig', () => {
    it('calls envLoader.reload()', () => {
      const spy = jest.spyOn(rendererConfig.envLoader, 'reload').mockImplementation(() => {});
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      rendererConfig.reloadConfig();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('logs reload message', () => {
      jest.spyOn(rendererConfig.envLoader, 'reload').mockImplementation(() => {});
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      rendererConfig.reloadConfig();
      expect(consoleSpy).toHaveBeenCalledWith('[RendererConfig] Configuration reloaded');
      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // Debug mode logging
  // =========================================================================

  describe('debug mode', () => {
    it('logs config snapshot when debugMode is true', () => {
      jest.isolateModules(() => {
        process.env.GURU_API_URL = 'http://127.0.0.1:8765';
        process.env.DEBUG_MODE = 'true';
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        require('../../../../src/core/config/renderer-config');
        expect(consoleSpy).toHaveBeenCalledWith(
          '[RendererConfig] Runtime configuration loaded:',
          expect.any(Object)
        );
        consoleSpy.mockRestore();
        delete process.env.DEBUG_MODE;
      });
    });
  });

  // =========================================================================
  // safeGet* with portResolver (isolateModules)
  // =========================================================================

  describe('safeGetBackendUrl with portResolver', () => {
    it('uses portResolver.getBackendUrl when available', () => {
      jest.isolateModules(() => {
        // Mock port-resolver to provide a dynamic URL
        jest.mock('../../../../src/core/config/port-resolver', () => ({
          getBackendUrl: jest.fn(() => 'http://127.0.0.1:9999'),
        }));
        process.env.GURU_API_URL = 'http://127.0.0.1:8765';
        const cfg = require('../../../../src/core/config/renderer-config');
        expect(cfg.backend.baseUrl).toBe('http://127.0.0.1:9999');
      });
    });

    it('falls back to static URL when portResolver.getBackendUrl throws', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/core/config/port-resolver', () => ({
          getBackendUrl: jest.fn(() => { throw new Error('fail'); }),
        }));
        process.env.GURU_API_URL = 'http://127.0.0.1:8765';
        const cfg = require('../../../../src/core/config/renderer-config');
        expect(cfg.backend.baseUrl).toBe('http://127.0.0.1:8765');
      });
    });
  });

  describe('safeGetBackendWsUrl with portResolver', () => {
    it('uses portResolver.getBackendWsUrl when available', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/core/config/port-resolver', () => ({
          getBackendUrl: jest.fn(u => u),
          getBackendWsUrl: jest.fn(() => 'ws://127.0.0.1:9999'),
        }));
        process.env.GURU_API_URL = 'http://127.0.0.1:8765';
        const cfg = require('../../../../src/core/config/renderer-config');
        expect(cfg.backend.wsUrl).toBe('ws://127.0.0.1:9999');
      });
    });

    it('falls back to http->ws replacement when portResolver.getBackendWsUrl throws', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/core/config/port-resolver', () => ({
          getBackendUrl: jest.fn(u => u),
          getBackendWsUrl: jest.fn(() => { throw new Error('fail'); }),
        }));
        process.env.GURU_API_URL = 'http://127.0.0.1:8765';
        const cfg = require('../../../../src/core/config/renderer-config');
        expect(cfg.backend.wsUrl).toMatch(/^ws:\/\//);
      });
    });

    it('converts https to wss in fallback', () => {
      jest.isolateModules(() => {
        // No port-resolver mock → try/catch falls through
        jest.mock('../../../../src/core/config/port-resolver', () => {
          throw new Error('not found');
        });
        process.env.GURU_API_URL = 'https://example.com';
        const cfg = require('../../../../src/core/config/renderer-config');
        expect(cfg.backend.wsUrl).toMatch(/^wss:\/\//);
      });
    });
  });

  // =========================================================================
  // Contract violations (isolateModules)
  // =========================================================================

  describe('backend.baseUrl contract violations', () => {
    it('throws when resolved URL is empty string', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/core/config/resolvers', () => ({
          resolveUrl: jest.fn(() => ''),
          resolveBoolean: jest.fn(() => false),
          resolveInt: jest.fn(() => 0),
          resolveTimeout: jest.fn(() => 1000),
          resolveLogLevel: jest.fn(() => 'info'),
          resolveSanitizerProfile: jest.fn(() => 'strict'),
          resolveStorageBackend: jest.fn(() => 'supabase'),
          resolveString: jest.fn(() => ''),
          resolveWsUrl: jest.fn(() => ''),
          resolveFullUrl: jest.fn((base, ep) => base + ep),
        }));
        jest.mock('../../../../src/core/config/validators', () => ({
          isValidUrl: jest.fn(() => true),
          normalizeUrl: jest.fn(u => u),
        }));
        const cfg = require('../../../../src/core/config/renderer-config');
        expect(() => cfg.backend.baseUrl).toThrow('CONTRACT VIOLATION');
      });
    });

    it('throws when resolved URL is not a valid URL', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/core/config/resolvers', () => ({
          resolveUrl: jest.fn(() => 'not-a-url'),
          resolveBoolean: jest.fn(() => false),
          resolveInt: jest.fn(() => 0),
          resolveTimeout: jest.fn(() => 1000),
          resolveLogLevel: jest.fn(() => 'info'),
          resolveSanitizerProfile: jest.fn(() => 'strict'),
          resolveStorageBackend: jest.fn(() => 'supabase'),
          resolveString: jest.fn(() => ''),
          resolveWsUrl: jest.fn(() => ''),
          resolveFullUrl: jest.fn((base, ep) => base + ep),
        }));
        jest.mock('../../../../src/core/config/validators', () => ({
          isValidUrl: jest.fn(() => false),
          normalizeUrl: jest.fn(u => u),
        }));
        jest.mock('../../../../src/core/config/port-resolver', () => {
          throw new Error('not found');
        });
        const cfg = require('../../../../src/core/config/renderer-config');
        expect(() => cfg.backend.baseUrl).toThrow('CONTRACT VIOLATION');
      });
    });
  });
});
