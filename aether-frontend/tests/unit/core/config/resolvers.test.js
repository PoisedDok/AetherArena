'use strict';

/**
 * Config Resolvers Unit Tests
 * ============================================================================
 * Validates configuration resolution logic
 */

const {
  resolveUrl,
  resolveBoolean,
  resolveInt,
  resolveTimeout,
  resolveLogLevel,
  resolveSanitizerProfile,
  resolveStorageBackend,
  resolveWsUrl,
  resolveFullUrl,
} = require('../../../../src/core/config/resolvers');

const { envLoader } = require('../../../../src/core/config/env-loader');
const DEFAULTS = require('../../../../src/core/config/defaults');

describe('Config Resolvers', () => {
  let originalEnv;
  let originalLocalStorage;
  let storage;

  beforeEach(() => {
    // Backup original environment
    originalEnv = { ...process.env };
    
    // Clear all test env vars from previous runs
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith('TEST_')) {
        delete process.env[key];
      }
    });
    
    // Clear envLoader cache to ensure fresh reads
    envLoader.clear();
    
    // Temporarily add TEST_ prefix to envLoader for testing
    // This allows test env vars to be picked up by envLoader
    if (!envLoader._prefixes.includes('TEST_')) {
      envLoader._prefixes = [...DEFAULTS.envPrefixes, 'TEST_'];
    }

    // Mock localStorage with fresh storage
    storage = {};
    originalLocalStorage = global.localStorage;
    
    // Create window.localStorage mock for resolver
    if (typeof global.window === 'undefined') {
      global.window = {};
    }
    
    global.window.localStorage = {
      getItem: (key) => storage[key] || null,
      setItem: (key, value) => {
        storage[key] = String(value);
      },
      removeItem: (key) => {
        delete storage[key];
      },
      clear: () => {
        Object.keys(storage).forEach((key) => delete storage[key]);
      },
    };
    
    global.localStorage = global.window.localStorage;
  });

  afterEach(() => {
    // Clear all test env vars
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith('TEST_')) {
        delete process.env[key];
      }
    });

    // Restore original environment completely
    process.env = originalEnv;
    
    // Restore original envLoader prefixes
    envLoader._prefixes = DEFAULTS.envPrefixes;
    
    // Clear envLoader cache again
    envLoader.clear();

    // Restore localStorage
    if (originalLocalStorage) {
      global.localStorage = originalLocalStorage;
      if (global.window) {
        global.window.localStorage = originalLocalStorage;
      }
    } else {
      delete global.localStorage;
      if (global.window) {
        delete global.window.localStorage;
      }
    }
    
    // Clear storage reference
    storage = null;
  });

  describe('resolveUrl', () => {
    test('should return default when no overrides', () => {
      const url = resolveUrl('TEST_URL', 'test_url', 'http://localhost:8000');
      expect(url).toBe('http://localhost:8000');
    });

    test('should prioritize localStorage over env', () => {
      process.env.TEST_URL = 'http://env:9000';
      global.window.localStorage.setItem('test_url', 'http://storage:7000');

      const url = resolveUrl('TEST_URL', 'test_url', 'http://localhost:8000');
      expect(url).toBe('http://storage:7000');
    });

    test('should use env when localStorage not set', () => {
      process.env.TEST_URL = 'http://env:9000';

      const url = resolveUrl('TEST_URL', 'test_url', 'http://localhost:8000');
      expect(url).toBe('http://env:9000');
    });

    test('should reject invalid URLs', () => {
      global.window.localStorage.setItem('test_url', 'not-a-url');

      const url = resolveUrl('TEST_URL', 'test_url', 'http://localhost:8000');
      // Should fallback to default on invalid URL
      expect(url).toBe('http://localhost:8000');
    });

    test('should normalize URLs by removing trailing slash', () => {
      process.env.TEST_URL = 'http://localhost:8000/';

      const url = resolveUrl('TEST_URL', 'test_url', 'http://localhost:8000');
      expect(url).toBe('http://localhost:8000');
    });
  });

  describe('resolveBoolean', () => {
    test('should parse true values correctly', () => {
      const testCases = ['true', 'TRUE', '1', 'yes', 'YES', 'on', 'ON'];

      testCases.forEach((value) => {
        process.env.TEST_BOOL = value;
        const result = resolveBoolean('TEST_BOOL', 'test_bool', false);
        expect(result).toBe(true);
      });
    });

    test('should parse false values correctly', () => {
      const testCases = ['false', 'FALSE', '0', 'no', 'NO', 'off', 'OFF'];

      testCases.forEach((value) => {
        process.env.TEST_BOOL = value;
        const result = resolveBoolean('TEST_BOOL', 'test_bool', true);
        expect(result).toBe(false);
      });
    });

    test('should return default for invalid values', () => {
      process.env.TEST_BOOL = 'invalid';

      const result = resolveBoolean('TEST_BOOL', 'test_bool', true);
      expect(result).toBe(true);
    });

    test('should prioritize localStorage', () => {
      process.env.TEST_BOOL = 'false';
      global.window.localStorage.setItem('test_bool', 'true');

      const result = resolveBoolean('TEST_BOOL', 'test_bool', false);
      expect(result).toBe(true);
    });
  });

  describe('resolveInt', () => {
    test('should parse integer values', () => {
      process.env.TEST_INT = '42';

      const result = resolveInt('TEST_INT', 'test_int', 10);
      expect(result).toBe(42);
    });

    test('should return default for invalid integers', () => {
      process.env.TEST_INT = 'not-a-number';

      const result = resolveInt('TEST_INT', 'test_int', 10);
      expect(result).toBe(10);
    });

    test('should reject negative numbers if min is 0', () => {
      process.env.TEST_INT = '-5';

      const result = resolveInt('TEST_INT', 'test_int', 10, 0);
      expect(result).toBe(10);
    });

    test('should enforce maximum values', () => {
      process.env.TEST_INT = '1000';

      // Values exceeding max should fallback to default
      const result = resolveInt('TEST_INT', 'test_int', 10, 0, 100);
      expect(result).toBe(10);
    });
  });

  describe('resolveTimeout', () => {
    test('should parse timeout values in milliseconds', () => {
      process.env.TEST_TIMEOUT = '5000';

      const result = resolveTimeout('TEST_TIMEOUT', 'test_timeout', 1000);
      expect(result).toBe(5000);
    });

    test('should enforce minimum timeout', () => {
      process.env.TEST_TIMEOUT = '10';

      const result = resolveTimeout('TEST_TIMEOUT', 'test_timeout', 1000);
      // Should use default or minimum
      expect(result).toBeGreaterThanOrEqual(100);
    });
  });

  describe('resolveLogLevel', () => {
    test('should parse valid log levels', () => {
      const validLevels = ['silent', 'error', 'warn', 'info', 'debug', 'trace'];

      validLevels.forEach((level) => {
        // Clear env between iterations
        envLoader.clear();
        process.env.TEST_LEVEL = level;
        const result = resolveLogLevel('TEST_LEVEL', 'test_level', 'info');
        expect(result).toBe(level);
      });
    });

    test('should return default for invalid log level', () => {
      process.env.TEST_LEVEL = 'invalid';

      // Invalid levels fallback to validator's built-in default ('info')
      const result = resolveLogLevel('TEST_LEVEL', 'test_level', 'info');
      expect(result).toBe('info');
    });

    test('should be case insensitive', () => {
      process.env.TEST_LEVEL = 'ERROR';

      const result = resolveLogLevel('TEST_LEVEL', 'test_level', 'info');
      expect(result).toBe('error');
    });
  });

  describe('resolveSanitizerProfile', () => {
    test('should parse valid sanitizer profiles', () => {
      const validProfiles = ['strict', 'default', 'permissive'];

      validProfiles.forEach((profile) => {
        // Clear env between iterations
        envLoader.clear();
        process.env.TEST_PROFILE = profile;
        const result = resolveSanitizerProfile('TEST_PROFILE', 'test_profile', 'strict');
        expect(result).toBe(profile);
      });
    });

    test('should return default for invalid profile', () => {
      process.env.TEST_PROFILE = 'invalid';

      // Invalid profiles fallback to validator's built-in default ('strict')
      const result = resolveSanitizerProfile('TEST_PROFILE', 'test_profile', 'strict');
      expect(result).toBe('strict');
    });
  });

  describe('resolveStorageBackend', () => {
    test('should parse valid storage backends', () => {
      // Valid backends according to validators.js: postgresql, sqlite, memory
      const validBackends = ['postgresql', 'sqlite', 'memory'];

      validBackends.forEach((backend) => {
        // Clear env between iterations
        envLoader.clear();
        process.env.TEST_BACKEND = backend;
        const result = resolveStorageBackend('TEST_BACKEND', 'test_backend', 'postgresql');
        expect(result).toBe(backend);
      });
    });

    test('should return default for invalid backend', () => {
      process.env.TEST_BACKEND = 'invalid';

      // Invalid backends fallback to validator's built-in default ('postgresql')
      const result = resolveStorageBackend('TEST_BACKEND', 'test_backend', 'postgresql');
      expect(result).toBe('postgresql');
    });
  });

  describe('resolveWsUrl', () => {
    test('should convert http to ws', () => {
      const wsUrl = resolveWsUrl('http://localhost:8765');
      expect(wsUrl).toBe('ws://localhost:8765');
    });

    test('should convert https to wss', () => {
      const wsUrl = resolveWsUrl('https://api.example.com:8765');
      expect(wsUrl).toBe('wss://api.example.com:8765');
    });

    test('should preserve port', () => {
      const wsUrl = resolveWsUrl('http://localhost:9000');
      expect(wsUrl).toBe('ws://localhost:9000');
    });

    test('should preserve path', () => {
      const wsUrl = resolveWsUrl('http://localhost:8765/api/v1');
      expect(wsUrl).toBe('ws://localhost:8765/api/v1');
    });
  });

  describe('resolveFullUrl', () => {
    test('should combine base URL and endpoint', () => {
      const fullUrl = resolveFullUrl('http://localhost:8765', '/api/test');
      expect(fullUrl).toBe('http://localhost:8765/api/test');
    });

    test('should handle base URL with trailing slash', () => {
      const fullUrl = resolveFullUrl('http://localhost:8765/', '/api/test');
      expect(fullUrl).toBe('http://localhost:8765/api/test');
    });

    test('should handle endpoint without leading slash', () => {
      const fullUrl = resolveFullUrl('http://localhost:8765', 'api/test');
      expect(fullUrl).toBe('http://localhost:8765/api/test');
    });

    test('should handle both trailing and leading slashes', () => {
      const fullUrl = resolveFullUrl('http://localhost:8765/', '/api/test');
      expect(fullUrl).toBe('http://localhost:8765/api/test');
    });
  });
});

