'use strict';

// ===========================================================================
// Module-level mocks (must be before require)
// ===========================================================================

const mockAppHandlers = {};
const mockApp = {
  on: jest.fn((event, handler) => {
    if (!mockAppHandlers[event]) mockAppHandlers[event] = [];
    mockAppHandlers[event].push(handler);
  }),
  disableHardwareAcceleration: jest.fn(),
  commandLine: { appendSwitch: jest.fn() },
};

const mockOnHeadersReceived = jest.fn();
const mockOnBeforeRequest = jest.fn();
const mockClearCache = jest.fn().mockResolvedValue(undefined);

const mockDefaultSession = {
  webRequest: {
    onHeadersReceived: mockOnHeadersReceived,
    onBeforeRequest: mockOnBeforeRequest,
  },
  clearCache: mockClearCache,
};

jest.mock('electron', () => ({
  app: mockApp,
  session: { defaultSession: mockDefaultSession },
}), { virtual: true });

const mockLoggerChild = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.mock('../../../src/core/utils/logger', () => ({
  logger: {
    child: jest.fn(() => mockLoggerChild),
  },
}));

// Mock CspManager
const mockCspManager = {
  enabled: true,
  getHeader: jest.fn(() => ({ name: 'Content-Security-Policy', value: "default-src 'self'" })),
  buildPolicy: jest.fn(() => "default-src 'self'"),
  getViolations: jest.fn(() => []),
};

jest.mock('../../../src/core/security/CspManager', () => ({
  CspManager: jest.fn(() => mockCspManager),
}));

// Mock ExternalLinkHandler
const mockExternalLinkHandler = {
  attach: jest.fn(),
};

jest.mock('../../../src/main/security/ExternalLinkHandler', () => ({
  ExternalLinkHandler: jest.fn(() => mockExternalLinkHandler),
}));

// Mock PermissionHandler
const mockPermissionHandler = {
  attachToSession: jest.fn(),
  attachToWindow: jest.fn(),
  getGlobalPolicy: jest.fn(() => ({ mode: 'development' })),
};

jest.mock('../../../src/main/security/PermissionHandler', () => ({
  PermissionHandler: jest.fn(() => mockPermissionHandler),
}));

// Mock PortManager (required dynamically inside callbacks)
jest.mock('../../../src/main/services/PortManager', () => ({
  PORT_RANGES: {
    backend: { start: 8765, end: 8775 },
    perplexica: { start: 3000, end: 3010 },
  },
}));

// Mock core config (required dynamically inside callbacks)
jest.mock('../../../src/core/config', () => ({
  backend: { baseUrl: 'http://127.0.0.1:8765' },
}));

// ===========================================================================
// Require after mocks
// ===========================================================================

const {
  SecurityManager,
  getManager,
  createManager,
  SECURITY_PROFILES,
} = require('../../../src/main/security/SecurityManager');

// ===========================================================================
// Helpers
// ===========================================================================

function createMockWebContents() {
  const handlers = {};
  return {
    on: jest.fn((event, handler) => { handlers[event] = handler; }),
    setWindowOpenHandler: jest.fn((handler) => { handlers['window-open'] = handler; }),
    executeJavaScript: jest.fn().mockResolvedValue(undefined),
    _handlers: handlers,
  };
}

function createMockWindow(overrides = {}) {
  const webContents = createMockWebContents();
  return {
    id: overrides.id || 1,
    isDestroyed: jest.fn(() => overrides.destroyed || false),
    webContents,
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('SecurityManager', () => {
  let manager;

  beforeEach(() => {
    // Clear captured app handlers between tests
    for (const key of Object.keys(mockAppHandlers)) {
      delete mockAppHandlers[key];
    }

    // Manually clear module-level mock call data (resetMocks may not reach these)
    mockExternalLinkHandler.attach.mockClear();
    mockPermissionHandler.attachToSession.mockClear();
    mockPermissionHandler.attachToWindow.mockClear();
    mockPermissionHandler.getGlobalPolicy.mockClear();
    mockCspManager.getHeader.mockClear();
    mockCspManager.buildPolicy.mockClear();
    mockCspManager.getViolations.mockClear();
    mockOnHeadersReceived.mockClear();
    mockOnBeforeRequest.mockClear();
    mockClearCache.mockClear();
    mockApp.on.mockClear();
    mockApp.disableHardwareAcceleration.mockClear();
    mockApp.commandLine.appendSwitch.mockClear();
    mockLoggerChild.info.mockClear();
    mockLoggerChild.warn.mockClear();
    mockLoggerChild.error.mockClear();
    mockLoggerChild.debug.mockClear();

    // Restore mock implementations that resetMocks may have cleared
    mockCspManager.enabled = true;
    mockCspManager.getHeader.mockReturnValue({ name: 'Content-Security-Policy', value: "default-src 'self'" });
    mockCspManager.buildPolicy.mockReturnValue("default-src 'self'");
    mockCspManager.getViolations.mockReturnValue([]);
    mockPermissionHandler.getGlobalPolicy.mockReturnValue({ mode: 'development' });
    mockClearCache.mockResolvedValue(undefined);

    manager = new SecurityManager();
  });

  // ==================== SECURITY_PROFILES ====================

  describe('SECURITY_PROFILES', () => {
    it('should export frozen profile objects', () => {
      expect(Object.isFrozen(SECURITY_PROFILES)).toBe(true);
      expect(Object.isFrozen(SECURITY_PROFILES.strict)).toBe(true);
      expect(Object.isFrozen(SECURITY_PROFILES.default)).toBe(true);
    });

    it('strict profile should enforce maximum security', () => {
      const strict = SECURITY_PROFILES.strict;
      expect(strict.sandbox.nodeIntegration).toBe(false);
      expect(strict.sandbox.contextIsolation).toBe(true);
      expect(strict.sandbox.webSecurity).toBe(true);
      expect(strict.sandbox.allowRunningInsecureContent).toBe(false);
      expect(strict.csp.enabled).toBe(true);
      expect(strict.csp.reportOnly).toBe(false);
      expect(strict.csp.environment).toBe('production');
    });

    it('default profile should enforce baseline security', () => {
      const def = SECURITY_PROFILES.default;
      expect(def.sandbox.nodeIntegration).toBe(false);
      expect(def.sandbox.contextIsolation).toBe(true);
      expect(def.sandbox.webSecurity).toBe(true);
      expect(def.csp.enabled).toBe(true);
    });

    it('strict profile should include CSP directives', () => {
      const directives = SECURITY_PROFILES.strict.csp.directives;
      expect(directives['default-src']).toEqual(["'self'"]);
      expect(directives['object-src']).toEqual(["'none'"]);
      expect(directives['frame-ancestors']).toEqual(["'none'"]);
    });
  });

  // ==================== constructor ====================

  describe('constructor', () => {
    it('should use default profile when no options provided', () => {
      expect(manager.profile).toBe(SECURITY_PROFILES.default);
      expect(manager.options.mode).toBe('default');
    });

    it('should select strict profile when mode is strict', () => {
      const strict = new SecurityManager({ mode: 'strict' });
      expect(strict.profile).toBe(SECURITY_PROFILES.strict);
    });

    it('should fall back to default for unknown mode', () => {
      const unknown = new SecurityManager({ mode: 'unknown_mode' });
      expect(unknown.profile).toBe(SECURITY_PROFILES.default);
    });

    it('should initialize state correctly', () => {
      expect(manager.initialized).toBe(false);
      expect(manager.securityEvents).toEqual([]);
      expect(manager.maxEvents).toBe(1000);
    });

    it('should enable auditing by default', () => {
      expect(manager.options.enableAuditing).toBe(true);
    });

    it('should allow disabling auditing', () => {
      const noAudit = new SecurityManager({ enableAuditing: false });
      expect(noAudit.options.enableAuditing).toBe(false);
    });

    it('should create security components', () => {
      const { CspManager } = require('../../../src/core/security/CspManager');
      const { ExternalLinkHandler } = require('../../../src/main/security/ExternalLinkHandler');
      const { PermissionHandler } = require('../../../src/main/security/PermissionHandler');

      expect(CspManager).toHaveBeenCalled();
      expect(ExternalLinkHandler).toHaveBeenCalled();
      expect(PermissionHandler).toHaveBeenCalled();
    });
  });

  // ==================== initialize ====================

  describe('initialize', () => {
    it('should set initialized flag on success', async () => {
      await manager.initialize();
      expect(manager.initialized).toBe(true);
    });

    it('should be idempotent — second call is a no-op', async () => {
      await manager.initialize();
      const callCountBefore = mockApp.on.mock.calls.length;

      await manager.initialize();

      // No additional app.on calls — already initialized
      expect(mockApp.on.mock.calls.length).toBe(callCountBefore);
      expect(mockLoggerChild.warn).toHaveBeenCalledWith('SecurityManager already initialized');
    });

    it('should configure app-level security', async () => {
      await manager.initialize();

      // commandLine switch added
      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith('disable-http-cache');
    });

    it('should register web-contents-created handler', async () => {
      await manager.initialize();

      expect(mockApp.on).toHaveBeenCalledWith('web-contents-created', expect.any(Function));
    });

    it('should configure session security', async () => {
      await manager.initialize();

      expect(mockPermissionHandler.attachToSession).toHaveBeenCalledWith(mockDefaultSession);
      expect(mockOnHeadersReceived).toHaveBeenCalledWith(expect.any(Function));
      expect(mockOnBeforeRequest).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should register security event handlers', async () => {
      await manager.initialize();

      expect(mockApp.on).toHaveBeenCalledWith('certificate-error', expect.any(Function));
      expect(mockApp.on).toHaveBeenCalledWith('login', expect.any(Function));
    });

    it('should propagate initialization errors', async () => {
      mockPermissionHandler.attachToSession.mockImplementationOnce(() => {
        throw new Error('Session attach failed');
      });

      await expect(manager.initialize()).rejects.toThrow('Session attach failed');
      expect(manager.initialized).toBe(false);
    });
  });

  // ==================== _configureAppSecurity ====================

  describe('_configureAppSecurity', () => {
    it('should disable hardware acceleration when disableGpu option is set', () => {
      const gpuManager = new SecurityManager({ disableGpu: true });
      gpuManager._configureAppSecurity();

      expect(mockApp.disableHardwareAcceleration).toHaveBeenCalled();
    });

    it('should not disable hardware acceleration by default', () => {
      mockApp.disableHardwareAcceleration.mockClear();
      manager._configureAppSecurity();

      expect(mockApp.disableHardwareAcceleration).not.toHaveBeenCalled();
    });
  });

  // ==================== _secureWebContents ====================

  describe('_secureWebContents', () => {
    let mockContents;

    beforeEach(() => {
      mockContents = createMockWebContents();
      manager._secureWebContents(mockContents);
    });

    it('should register will-navigate handler', () => {
      expect(mockContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
    });

    it('should register window-open handler', () => {
      expect(mockContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should register did-finish-load handler', () => {
      expect(mockContents.on).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
    });

    it('should block navigation to non-file URLs', () => {
      const handler = mockContents._handlers['will-navigate'];
      const mockEvent = { preventDefault: jest.fn() };

      handler(mockEvent, 'https://evil.com/phish');

      expect(mockEvent.preventDefault).toHaveBeenCalled();
    });

    it('should allow navigation to file: URLs', () => {
      const handler = mockContents._handlers['will-navigate'];
      const mockEvent = { preventDefault: jest.fn() };

      handler(mockEvent, 'file:///app/index.html');

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('should allow navigation to devtools: URLs', () => {
      const handler = mockContents._handlers['will-navigate'];
      const mockEvent = { preventDefault: jest.fn() };

      handler(mockEvent, 'devtools://devtools/inspector.html');

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('should record security event when navigation blocked', () => {
      const handler = mockContents._handlers['will-navigate'];
      const mockEvent = { preventDefault: jest.fn() };

      handler(mockEvent, 'https://malicious.com');

      expect(manager.securityEvents.length).toBe(1);
      expect(manager.securityEvents[0].type).toBe('navigation-blocked');
      expect(manager.securityEvents[0].data.url).toBe('https://malicious.com');
    });

    it('should deny window.open calls', () => {
      const handler = mockContents._handlers['window-open'];
      const result = handler();

      expect(result).toEqual({ action: 'deny' });
    });

    it('should record security event for window.open', () => {
      const handler = mockContents._handlers['window-open'];
      handler();

      expect(manager.securityEvents.some(e => e.type === 'window-open-blocked')).toBe(true);
    });

    it('should inject WebRTC prevention when option is set', () => {
      const rtcManager = new SecurityManager({ preventWebRTCLeak: true });
      const rtcContents = createMockWebContents();
      rtcManager._secureWebContents(rtcContents);

      const handler = rtcContents._handlers['did-finish-load'];
      handler();

      expect(rtcContents.executeJavaScript).toHaveBeenCalled();
      const injectedCode = rtcContents.executeJavaScript.mock.calls[0][0];
      expect(injectedCode).toContain('RTCPeerConnection');
    });

    it('should NOT inject WebRTC prevention by default', () => {
      const handler = mockContents._handlers['did-finish-load'];
      handler();

      expect(mockContents.executeJavaScript).not.toHaveBeenCalled();
    });
  });

  // ==================== _configureSessionSecurity — headers ====================

  describe('_configureSessionSecurity — onHeadersReceived', () => {
    let headersCallback;

    beforeEach(async () => {
      await manager._configureSessionSecurity(mockDefaultSession);
      headersCallback = mockOnHeadersReceived.mock.calls[0][0];
    });

    it('should inject CSP header when enabled', () => {
      const callback = jest.fn();
      headersCallback({ url: 'file:///app/index.html', responseHeaders: {} }, callback);

      const result = callback.mock.calls[0][0];
      expect(result.responseHeaders['Content-Security-Policy']).toEqual(["default-src 'self'"]);
    });

    it('should inject standard security headers', () => {
      const callback = jest.fn();
      headersCallback({ url: 'file:///app/index.html', responseHeaders: {} }, callback);

      const headers = callback.mock.calls[0][0].responseHeaders;
      expect(headers['X-Content-Type-Options']).toEqual(['nosniff']);
      expect(headers['X-Frame-Options']).toEqual(['DENY']);
      expect(headers['X-XSS-Protection']).toEqual(['1; mode=block']);
      expect(headers['Referrer-Policy']).toEqual(['no-referrer']);
      expect(headers['Permissions-Policy']).toEqual(['geolocation=(), microphone=(), camera=()']);
    });

    it('should strip X-Frame-Options for local service URLs', () => {
      const callback = jest.fn();
      headersCallback({
        url: 'http://127.0.0.1:8770/dashboard',
        responseHeaders: {},
      }, callback);

      const headers = callback.mock.calls[0][0].responseHeaders;
      // X-Frame-Options should be removed for local services
      expect(headers['X-Frame-Options']).toBeUndefined();
      expect(headers['x-frame-options']).toBeUndefined();
    });

    it('should inject CORS headers for local service URLs', () => {
      const callback = jest.fn();
      headersCallback({
        url: 'http://localhost:3005/api',
        responseHeaders: {},
      }, callback);

      const headers = callback.mock.calls[0][0].responseHeaders;
      expect(headers['Access-Control-Allow-Origin']).toEqual(['*']);
      expect(headers['Access-Control-Allow-Methods']).toBeDefined();
      expect(headers['Access-Control-Allow-Headers']).toEqual(['*']);
    });

    it('should NOT strip X-Frame-Options for non-local URLs', () => {
      const callback = jest.fn();
      headersCallback({
        url: 'https://external.com/page',
        responseHeaders: {},
      }, callback);

      const headers = callback.mock.calls[0][0].responseHeaders;
      expect(headers['X-Frame-Options']).toEqual(['DENY']);
    });

    it('should NOT treat out-of-range local ports as services', () => {
      const callback = jest.fn();
      headersCallback({
        url: 'http://127.0.0.1:9999/page',
        responseHeaders: {},
      }, callback);

      const headers = callback.mock.calls[0][0].responseHeaders;
      // X-Frame-Options should still be DENY (port not in range)
      expect(headers['X-Frame-Options']).toEqual(['DENY']);
    });

    it('should not inject CSP header when cspManager is disabled', async () => {
      mockCspManager.enabled = false;
      const callback = jest.fn();
      headersCallback({ url: 'file:///app/index.html', responseHeaders: {} }, callback);

      const headers = callback.mock.calls[0][0].responseHeaders;
      expect(headers['Content-Security-Policy']).toBeUndefined();
      mockCspManager.enabled = true; // Restore
    });
  });

  // ==================== _configureSessionSecurity — onBeforeRequest ====================

  describe('_configureSessionSecurity — onBeforeRequest', () => {
    let requestCallback;

    beforeEach(async () => {
      await manager._configureSessionSecurity(mockDefaultSession);
      requestCallback = mockOnBeforeRequest.mock.calls[0][0];
    });

    it('should allow HTTPS requests', () => {
      const callback = jest.fn();
      requestCallback({ url: 'https://api.example.com/data' }, callback);

      expect(callback).toHaveBeenCalledWith({});
    });

    it('should allow localhost HTTP in configured port ranges', () => {
      const callback = jest.fn();
      requestCallback({ url: 'http://127.0.0.1:8770/api' }, callback);

      expect(callback).toHaveBeenCalledWith({});
    });

    it('should allow configured backend URL', () => {
      const callback = jest.fn();
      requestCallback({ url: 'http://127.0.0.1:8765/v1/chats' }, callback);

      expect(callback).toHaveBeenCalledWith({});
    });

    it('should block insecure HTTP to non-local URLs', () => {
      const callback = jest.fn();
      requestCallback({ url: 'http://evil.com/steal-data' }, callback);

      expect(callback).toHaveBeenCalledWith({ cancel: true });
    });

    it('should record security event when blocking insecure request', () => {
      const callback = jest.fn();
      requestCallback({ url: 'http://evil.com/malware' }, callback);

      expect(manager.securityEvents.some(e => e.type === 'insecure-request-blocked')).toBe(true);
    });

    it('should allow localhost perplexica port range', () => {
      const callback = jest.fn();
      requestCallback({ url: 'http://localhost:3005/search' }, callback);

      expect(callback).toHaveBeenCalledWith({});
    });

    it('should allow file: protocol', () => {
      const callback = jest.fn();
      requestCallback({ url: 'file:///app/index.html' }, callback);

      expect(callback).toHaveBeenCalledWith({});
    });

    it('should clear cache when clearCacheOnStartup option is set', async () => {
      const cacheManager = new SecurityManager({ clearCacheOnStartup: true });
      mockClearCache.mockClear();
      await cacheManager._configureSessionSecurity(mockDefaultSession);

      expect(mockClearCache).toHaveBeenCalled();
    });
  });

  // ==================== _setupSecurityEventHandlers ====================

  describe('_setupSecurityEventHandlers', () => {
    beforeEach(() => {
      manager._setupSecurityEventHandlers();
    });

    it('should register certificate-error handler', () => {
      expect(mockApp.on).toHaveBeenCalledWith('certificate-error', expect.any(Function));
    });

    it('should deny certificate errors', () => {
      const handler = mockAppHandlers['certificate-error']?.[0];
      expect(handler).toBeDefined();

      const callback = jest.fn();
      handler({}, null, 'https://bad-cert.com', 'ERR_CERT', {}, callback);

      // Must deny (false = reject certificate)
      expect(callback).toHaveBeenCalledWith(false);
    });

    it('should record certificate error event', () => {
      const handler = mockAppHandlers['certificate-error'][0];
      handler({}, null, 'https://bad-cert.com', 'ERR_CERT', {}, jest.fn());

      expect(manager.securityEvents.some(e => e.type === 'certificate-error')).toBe(true);
    });

    it('should register login handler', () => {
      expect(mockApp.on).toHaveBeenCalledWith('login', expect.any(Function));
    });

    it('should deny login requests with empty credentials', () => {
      const handler = mockAppHandlers['login']?.[0];
      expect(handler).toBeDefined();

      const mockEvent = { preventDefault: jest.fn() };
      const callback = jest.fn();
      handler(mockEvent, null, {}, { scheme: 'basic' }, callback);

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith('', '');
    });

    it('should record login request event', () => {
      const handler = mockAppHandlers['login'][0];
      handler({ preventDefault: jest.fn() }, null, {}, { scheme: 'basic' }, jest.fn());

      expect(manager.securityEvents.some(e => e.type === 'login-request')).toBe(true);
    });
  });

  // ==================== secureWindow ====================

  describe('secureWindow', () => {
    it('should attach external link handler and permission handler', () => {
      const mockWindow = createMockWindow();
      manager.secureWindow(mockWindow);

      expect(mockExternalLinkHandler.attach).toHaveBeenCalledWith(mockWindow, {});
      expect(mockPermissionHandler.attachToWindow).toHaveBeenCalledWith(mockWindow);
    });

    it('should register console-message and render-process-gone listeners', () => {
      const mockWindow = createMockWindow();
      manager.secureWindow(mockWindow);

      expect(mockWindow.webContents.on).toHaveBeenCalledWith('console-message', expect.any(Function));
      expect(mockWindow.webContents.on).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    });

    it('should record security event on CSP console warning', () => {
      const mockWindow = createMockWindow();
      manager.secureWindow(mockWindow);

      const consoleHandler = mockWindow.webContents._handlers['console-message'];
      consoleHandler({}, 1, 'Refused to load: CSP violation');

      expect(manager.securityEvents.some(e => e.type === 'console-security-warning')).toBe(true);
    });

    it('should ignore non-security console messages', () => {
      const mockWindow = createMockWindow();
      manager.secureWindow(mockWindow);

      const consoleHandler = mockWindow.webContents._handlers['console-message'];
      const eventCountBefore = manager.securityEvents.length;
      consoleHandler({}, 0, 'Normal log message');

      expect(manager.securityEvents.length).toBe(eventCountBefore);
    });

    it('should record renderer crash event', () => {
      const mockWindow = createMockWindow();
      manager.secureWindow(mockWindow);

      const crashHandler = mockWindow.webContents._handlers['render-process-gone'];
      crashHandler({}, { reason: 'oom' });

      expect(manager.securityEvents.some(e => e.type === 'renderer-crash')).toBe(true);
    });

    it('should handle destroyed window gracefully', () => {
      const mockWindow = createMockWindow({ destroyed: true });

      // Should not throw
      manager.secureWindow(mockWindow);

      expect(mockExternalLinkHandler.attach).not.toHaveBeenCalled();
    });

    it('should handle null window gracefully', () => {
      manager.secureWindow(null);

      expect(mockLoggerChild.warn).toHaveBeenCalledWith('Cannot secure invalid window');
    });
  });

  // ==================== getSecurePreferences ====================

  describe('getSecurePreferences', () => {
    it('should return secure defaults from profile', () => {
      const prefs = manager.getSecurePreferences();

      expect(prefs.nodeIntegration).toBe(false);
      expect(prefs.contextIsolation).toBe(true);
      expect(prefs.webSecurity).toBe(true);
      expect(prefs.sandbox).toBe(true);
      expect(prefs.allowRunningInsecureContent).toBe(false);
      expect(prefs.enableRemoteModule).toBe(false);
      expect(prefs.enableWebSQL).toBe(false);
      expect(prefs.spellcheck).toBe(true);
    });

    it('should merge custom preferences (override capability)', () => {
      const prefs = manager.getSecurePreferences({ spellcheck: false });

      expect(prefs.spellcheck).toBe(false);
      // Defaults still present
      expect(prefs.nodeIntegration).toBe(false);
    });

    it('should allow custom prefs to override security defaults (documented behavior)', () => {
      // This is by design — callers take responsibility
      const prefs = manager.getSecurePreferences({ nodeIntegration: true });

      expect(prefs.nodeIntegration).toBe(true);
    });

    it('should return strict profile preferences when mode is strict', () => {
      const strict = new SecurityManager({ mode: 'strict' });
      const prefs = strict.getSecurePreferences();

      expect(prefs.experimentalFeatures).toBe(false);
      expect(prefs.enableBlinkFeatures).toBe('');
    });
  });

  // ==================== audit ====================

  describe('audit', () => {
    it('should return frozen audit report with all sections', () => {
      const report = manager.audit();

      expect(Object.isFrozen(report)).toBe(true);
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('mode');
      expect(report).toHaveProperty('csp');
      expect(report).toHaveProperty('sandbox');
      expect(report).toHaveProperty('permissions');
      expect(report).toHaveProperty('events');
      expect(report).toHaveProperty('recommendations');
    });

    it('should include CSP status from cspManager', () => {
      const report = manager.audit();

      expect(report.csp.enabled).toBe(true);
      expect(report.csp.policy).toBe("default-src 'self'");
      expect(report.csp.violations).toBe(0);
    });

    it('should include events summary', () => {
      // Add some events
      manager._recordSecurityEvent('test-event', { detail: 'foo' });
      manager._recordSecurityEvent('test-event-2', { detail: 'bar' });

      const report = manager.audit();

      expect(report.events.total).toBe(2);
      expect(report.events.recent.length).toBe(2);
    });

    it('should limit recent events to last 10', () => {
      for (let i = 0; i < 15; i++) {
        manager._recordSecurityEvent('bulk-event', { idx: i });
      }

      const report = manager.audit();

      expect(report.events.total).toBe(15);
      expect(report.events.recent.length).toBe(10);
    });
  });

  // ==================== _generateRecommendations ====================

  describe('_generateRecommendations', () => {
    it('should return empty array when all security features enabled (default profile)', () => {
      const recs = manager._generateRecommendations();
      expect(recs).toEqual([]);
    });

    it('should flag disabled CSP', () => {
      mockCspManager.enabled = false;
      const recs = manager._generateRecommendations();
      expect(recs.some(r => r.category === 'csp' && r.severity === 'high')).toBe(true);
      mockCspManager.enabled = true;
    });

    it('should flag disabled sandbox', () => {
      const insecure = new SecurityManager({ mode: 'strict' });
      // Override profile sandbox
      insecure.profile = { ...SECURITY_PROFILES.strict, sandbox: { ...SECURITY_PROFILES.strict.sandbox, enabled: false } };

      const recs = insecure._generateRecommendations();
      expect(recs.some(r => r.category === 'sandbox' && r.issue === 'Renderer sandbox disabled')).toBe(true);
    });

    it('should flag disabled context isolation', () => {
      const insecure = new SecurityManager();
      insecure.profile = { ...SECURITY_PROFILES.default, sandbox: { ...SECURITY_PROFILES.default.sandbox, contextIsolation: false } };

      const recs = insecure._generateRecommendations();
      expect(recs.some(r => r.issue === 'Context isolation disabled')).toBe(true);
    });

    it('should flag enabled node integration', () => {
      const insecure = new SecurityManager();
      insecure.profile = { ...SECURITY_PROFILES.default, sandbox: { ...SECURITY_PROFILES.default.sandbox, nodeIntegration: true } };

      const recs = insecure._generateRecommendations();
      expect(recs.some(r => r.issue === 'Node integration enabled')).toBe(true);
    });
  });

  // ==================== _recordSecurityEvent ====================

  describe('_recordSecurityEvent', () => {
    it('should append event with type, timestamp, and data', () => {
      manager._recordSecurityEvent('test-type', { key: 'val' });

      expect(manager.securityEvents.length).toBe(1);
      expect(manager.securityEvents[0].type).toBe('test-type');
      expect(manager.securityEvents[0].data).toEqual({ key: 'val' });
      expect(typeof manager.securityEvents[0].timestamp).toBe('number');
    });

    it('should trim events when exceeding maxEvents', () => {
      manager.maxEvents = 5;
      for (let i = 0; i < 7; i++) {
        manager._recordSecurityEvent('trim-event', { idx: i });
      }

      expect(manager.securityEvents.length).toBe(5);
      // Oldest events trimmed — first event should have idx=2
      expect(manager.securityEvents[0].data.idx).toBe(2);
    });

    it('should log event when auditing is enabled', () => {
      manager._recordSecurityEvent('audit-event', {});
      expect(mockLoggerChild.warn).toHaveBeenCalledWith(
        'Security event',
        expect.objectContaining({ type: 'audit-event' })
      );
    });

    it('should NOT log event when auditing is disabled', () => {
      const noAudit = new SecurityManager({ enableAuditing: false });
      mockLoggerChild.warn.mockClear();
      noAudit._recordSecurityEvent('silent-event', {});

      // warn should not have been called with 'Security event'
      const secEventCalls = mockLoggerChild.warn.mock.calls.filter(c => c[0] === 'Security event');
      expect(secEventCalls.length).toBe(0);
    });
  });

  // ==================== getSecurityEvents ====================

  describe('getSecurityEvents', () => {
    beforeEach(() => {
      const now = Date.now();
      manager.securityEvents = [
        { type: 'nav-blocked', timestamp: now - 5000, data: {} },
        { type: 'cert-error', timestamp: now - 3000, data: {} },
        { type: 'nav-blocked', timestamp: now - 1000, data: {} },
        { type: 'crash', timestamp: now, data: {} },
      ];
    });

    it('should return all events when no filter', () => {
      const events = manager.getSecurityEvents();
      expect(events.length).toBe(4);
    });

    it('should filter by type', () => {
      const events = manager.getSecurityEvents({ type: 'nav-blocked' });
      expect(events.length).toBe(2);
      expect(events.every(e => e.type === 'nav-blocked')).toBe(true);
    });

    it('should filter by since timestamp', () => {
      const since = Date.now() - 2000;
      const events = manager.getSecurityEvents({ since });
      expect(events.length).toBe(2); // last two events
    });

    it('should limit results', () => {
      const events = manager.getSecurityEvents({ limit: 2 });
      expect(events.length).toBe(2);
      // Should be last 2 (slice(-2))
      expect(events[1].type).toBe('crash');
    });

    it('should combine filters', () => {
      const events = manager.getSecurityEvents({ type: 'nav-blocked', limit: 1 });
      expect(events.length).toBe(1);
    });

    it('should return a copy, not a reference', () => {
      const events = manager.getSecurityEvents();
      events.push({ type: 'injected', timestamp: 0, data: {} });

      expect(manager.securityEvents.length).toBe(4); // Original unchanged
    });
  });

  // ==================== clearSecurityEvents ====================

  describe('clearSecurityEvents', () => {
    it('should clear all events', () => {
      manager._recordSecurityEvent('a', {});
      manager._recordSecurityEvent('b', {});
      expect(manager.securityEvents.length).toBe(2);

      manager.clearSecurityEvents();

      expect(manager.securityEvents.length).toBe(0);
    });
  });

  // ==================== shutdown ====================

  describe('shutdown', () => {
    it('should reset initialized flag', async () => {
      await manager.initialize();
      expect(manager.initialized).toBe(true);

      manager.shutdown();

      expect(manager.initialized).toBe(false);
    });

    it('should run final audit when auditing is enabled', () => {
      const auditSpy = jest.spyOn(manager, 'audit');
      manager.shutdown();

      expect(auditSpy).toHaveBeenCalled();
      auditSpy.mockRestore();
    });

    it('should NOT run audit when auditing is disabled', () => {
      const noAudit = new SecurityManager({ enableAuditing: false });
      const auditSpy = jest.spyOn(noAudit, 'audit');
      noAudit.shutdown();

      expect(auditSpy).not.toHaveBeenCalled();
      auditSpy.mockRestore();
    });
  });

  // ==================== _logSecurityStatus ====================

  describe('_logSecurityStatus', () => {
    it('should log security configuration details', () => {
      mockLoggerChild.info.mockClear();
      manager._logSecurityStatus();

      // Should log mode, CSP enabled, sandbox settings
      const infoCalls = mockLoggerChild.info.mock.calls.map(c => c[0]);
      expect(infoCalls.some(msg => typeof msg === 'string' && msg.includes('SECURITY STATUS'))).toBe(true);
    });
  });

  // ==================== Factory functions ====================

  describe('createManager', () => {
    it('should return a new SecurityManager instance', () => {
      const mgr = createManager({ mode: 'strict' });
      expect(mgr).toBeInstanceOf(SecurityManager);
      expect(mgr.profile).toBe(SECURITY_PROFILES.strict);
    });

    it('should create independent instances', () => {
      const mgr1 = createManager();
      const mgr2 = createManager();
      expect(mgr1).not.toBe(mgr2);
    });
  });

  // ==================== web-contents-created integration ====================

  describe('web-contents-created integration', () => {
    it('should secure new web contents via app event handler', async () => {
      await manager.initialize();

      // Get the web-contents-created handler registered on app
      const handler = mockAppHandlers['web-contents-created']?.[0];
      expect(handler).toBeDefined();

      // Invoke it with a mock web contents
      const mockContents = createMockWebContents();
      handler({}, mockContents);

      // Verify will-navigate and window-open handlers were set up
      expect(mockContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function));
      expect(mockContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  // ==================== onHeadersReceived — CSP frame-ancestors ====================

  describe('onHeadersReceived — CSP frame-ancestors for local services', () => {
    it('should modify frame-ancestors in existing CSP for local service URLs', async () => {
      // Make cspManager inject a CSP containing frame-ancestors (simulates real CSP)
      mockCspManager.getHeader.mockReturnValue({
        name: 'Content-Security-Policy',
        value: "default-src 'self'; frame-ancestors 'none'",
      });

      await manager._configureSessionSecurity(mockDefaultSession);
      const headersCallback = mockOnHeadersReceived.mock.calls[0][0];

      const callback = jest.fn();
      headersCallback({
        url: 'http://127.0.0.1:3005/page',
        responseHeaders: {},
      }, callback);

      const headers = callback.mock.calls[0][0].responseHeaders;
      const csp = headers['Content-Security-Policy'][0];
      // frame-ancestors should be modified to allow app:, aether:, file: and localhost
      expect(csp).toContain('frame-ancestors');
      expect(csp).toContain('app:');
      expect(csp).toContain('aether:');
      expect(csp).toContain('file:');
      expect(csp).toContain('localhost:*');

      // Restore default mock
      mockCspManager.getHeader.mockReturnValue({ name: 'Content-Security-Policy', value: "default-src 'self'" });
    });
  });

  // ==================== secureWindow — error handling ====================

  describe('secureWindow — attach error', () => {
    it('should handle error during external link handler attach', () => {
      mockExternalLinkHandler.attach.mockImplementationOnce(() => {
        throw new Error('Attach failed');
      });

      const mockWindow = createMockWindow();

      // Should NOT throw — error is caught
      expect(() => manager.secureWindow(mockWindow)).not.toThrow();
      expect(mockLoggerChild.error).toHaveBeenCalledWith(
        'Failed to secure window',
        expect.objectContaining({ error: 'Attach failed' })
      );
    });
  });

  // ==================== getManager singleton ====================

  describe('getManager', () => {
    it('should return a SecurityManager instance', () => {
      const mgr = getManager();
      expect(mgr).toBeInstanceOf(SecurityManager);
    });

    it('should return same instance on subsequent calls', () => {
      const mgr1 = getManager();
      const mgr2 = getManager();
      expect(mgr1).toBe(mgr2);
    });
  });
});
