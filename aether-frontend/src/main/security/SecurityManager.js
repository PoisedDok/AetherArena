'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron app/session events (web-contents-created, certificate-error, login), BrowserWindow (secureWindow method) --- {electron_event, Event | BrowserWindow}
 * Processing: Orchestrate CSP (CspManager via meta tag + HTTP headers), renderer sandboxing (nodeIntegration=false, contextIsolation=true, webSecurity=true), external link protection (ExternalLinkHandler), permission management (PermissionHandler), security auditing (record events), configure session.webRequest (CSP headers, block insecure HTTP except localhost, X-Content-Type-Options, X-Frame-Options, X-XSS-Protection), inject CSP on did-finish-load, prevent will-navigate/window.open via _secureWebContents, monitor console/crashes, provide SECURITY_PROFILES (strict/default) --- {9 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: session.webRequest (response headers), webContents (injected CSP + security scripts), audit reports --- {electron_session | audit_report, Session | object}
 * 
 * 
 * @module main/security/SecurityManager
 * 
 * SecurityManager - Unified Security Orchestration
 * ============================================================================
 * Coordinates all security components for main process:
 * - Content Security Policy (CSP)
 * - Renderer sandboxing
 * - External link protection
 * - Permission management
 * - Security auditing
 * - Compliance verification
 * 
 * @module main/security/SecurityManager
 */

const { app, session } = require('electron');
const { logger } = require('../../core/utils/logger');
const { CspManager } = require('../../core/security/CspManager');
const { ExternalLinkHandler } = require('./ExternalLinkHandler');
const { PermissionHandler } = require('./PermissionHandler');

/**
 * Security configuration profiles
 */
const SECURITY_PROFILES = Object.freeze({
  // Maximum security (production)
  strict: Object.freeze({
    csp: {
      environment: 'production',
      enabled: true,
      reportOnly: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    sandbox: {
      enabled: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: '',
      disableBlinkFeatures: '',
    },
    permissions: {
      mode: 'production',
    },
    externalLinks: {
      openExternal: true,
      logBlocked: true,
    },
  }),

  // Balanced security (default)
  default: Object.freeze({
    csp: {
      environment: 'development',
      enabled: true,
      reportOnly: false,
    },
    sandbox: {
      enabled: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    permissions: {
      mode: 'development',
    },
    externalLinks: {
      openExternal: true,
      logBlocked: true,
    },
  }),
});

// ============================================================================
// SecurityManager Class
// ============================================================================

class SecurityManager {
  constructor(options = {}) {
    this.options = {
      profile: options.profile || 'default',
      mode: options.mode || (process.env.NODE_ENV === 'production' ? 'strict' : 'default'),
      enableAuditing: options.enableAuditing !== false,
      ...options,
    };

    // Get profile configuration
    this.profile = SECURITY_PROFILES[this.options.mode] || SECURITY_PROFILES.default;
    
    // State
    this.initialized = false;
    this.securityEvents = [];
    this.maxEvents = 1000;
    
    this.logger = logger.child({ module: 'SecurityManager' });
    
    // Initialize security components synchronously for tests
    // In production, call initialize() when app is ready
    this.cspManager = new CspManager({
      ...this.profile.csp,
      reportUri: this.options.cspReportUri || null,
    });
    
    this.externalLinkHandler = new ExternalLinkHandler({
      ...this.profile.externalLinks,
    });
    
    this.permissionHandler = new PermissionHandler({
      ...this.profile.permissions,
    });
  }

  /**
   * Initialize security manager
   * Must be called before app is ready
   */
  async initialize() {
    if (this.initialized) {
      this.logger.warn('SecurityManager already initialized');
      return;
    }

    this.logger.info('Initializing SecurityManager', {
      mode: this.options.mode,
      profile: this.profile,
    });

    try {
      // 1. Configure app-level security
      this._configureAppSecurity();

      // 2. Configure default session security
      await this._configureSessionSecurity(session.defaultSession);

      // 3. Set up security event handlers
      this._setupSecurityEventHandlers();

      this.initialized = true;
      this.logger.info('SecurityManager initialized successfully');
      
      // Log security status
      this._logSecurityStatus();
    } catch (error) {
      this.logger.error('SecurityManager initialization failed', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Configure app-level security settings
   * @private
   */
  _configureAppSecurity() {
    this.logger.debug('Configuring app-level security');

    // Disable GPU if needed for security
    if (this.options.disableGpu) {
      app.disableHardwareAcceleration();
      this.logger.info('Hardware acceleration disabled for security');
    }

    // Set secure protocols
    app.commandLine.appendSwitch('disable-http-cache');
    
    // Restrict navigation
    app.on('web-contents-created', (event, contents) => {
      this._secureWebContents(contents);
    });
  }

  /**
   * Secure WebContents
   * @private
   */
  _secureWebContents(contents) {
    // Prevent navigation to external URLs
    contents.on('will-navigate', (event, navigationUrl) => {
      const parsedUrl = new URL(navigationUrl);
      
      if (parsedUrl.protocol !== 'file:' && parsedUrl.protocol !== 'devtools:') {
        this.logger.warn('Prevented navigation', { url: navigationUrl });
        this._recordSecurityEvent('navigation-blocked', { url: navigationUrl });
        event.preventDefault();
      }
    });

    // Prevent creating new windows
    contents.setWindowOpenHandler(() => {
      this.logger.warn('Prevented window.open()');
      this._recordSecurityEvent('window-open-blocked');
      return { action: 'deny' };
    });

    // Inject CSP and security hardening on page load
    contents.on('did-finish-load', () => {
      // Prevent WebRTC IP leak
      if (this.options.preventWebRTCLeak) {
        contents.executeJavaScript(`
          if (typeof RTCPeerConnection !== 'undefined') {
            const OriginalRTCPeerConnection = RTCPeerConnection;
            RTCPeerConnection = function() {
              throw new Error('WebRTC disabled for security');
            };
          }
        `).catch((err) => {
            this.logger.debug('WebRTC disable failed or already applied', { error: err?.message || String(err) });
        });
      }
    });
  }

  /**
   * Configure session security
   * @private
   */
  async _configureSessionSecurity(electronSession) {
    this.logger.debug('Configuring session security');

    // 1. Attach permission handler
    this.permissionHandler.attachToSession(electronSession);

    // 2. Set CSP headers
    electronSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      const url = details.url;

      // Detect if this is a response from one of our whitelisted local services
      let isLocalService = false;
      try {
        const u = new URL(url);
        if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') {
          const { PORT_RANGES } = require('../services/PortManager');
          const port = Number(u.port);
          if (Number.isFinite(port)) {
            for (const range of Object.values(PORT_RANGES)) {
              if (port >= range.start && port <= range.end) {
                isLocalService = true;
                break;
              }
            }
          }
        }
      } catch (err) {
        this.logger.debug('Failed to parse URL for local service check', { url, error: err?.message || String(err) });
      }

      if (this.cspManager.enabled) {
        const cspHeader = this.cspManager.getHeader();
        headers[cspHeader.name] = [cspHeader.value];
      }

      // Security headers for our own app
      headers['X-Content-Type-Options'] = ['nosniff'];
      headers['X-Frame-Options'] = ['DENY'];
      headers['X-XSS-Protection'] = ['1; mode=block'];
      headers['Referrer-Policy'] = ['no-referrer'];
      headers['Permissions-Policy'] = ['geolocation=(), microphone=(), camera=()'];

      // If it's a local service (like the Agent Dashboard), we MUST strip framing restrictions
      // and allow CORS so fonts and fetches work correctly inside the iframe.
      if (isLocalService) {
        // Remove X-Frame-Options if present
        delete headers['X-Frame-Options'];
        delete headers['x-frame-options'];

        // Inject CORS headers
        headers['Access-Control-Allow-Origin'] = ['*'];
        headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS, PUT, DELETE'];
        headers['Access-Control-Allow-Headers'] = ['*'];

        // Modify CSP frame-ancestors to allow our app
        const cspKeys = ['Content-Security-Policy', 'content-security-policy'];
        for (const key of cspKeys) {
          if (headers[key]) {
            headers[key] = headers[key].map(policy => {
              // Explicitly allow file: and localhost for the Electron parent
              // 'frame-ancestors *' excludes file: scheme by default
              if (policy.toLowerCase().includes('frame-ancestors')) {
                return policy.replace(/frame-ancestors\s+[^;]+(;|$)/gi, "frame-ancestors 'self' app: aether: file: localhost:* 127.0.0.1:*$1");
              }
              return policy;
            });
          }
        }
      }

      callback({ responseHeaders: headers });
    });

    // 3. Block insecure content
    electronSession.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;

      // Allow loopback HTTP to discovered service ports (dev only).
      // This avoids coupling security policy to core/config getters (which can fail-fast during early boot),
      // and matches PortManager's defined service ranges (backend, perplexica, etc).
      try {
        if (url.startsWith('http://')) {
          const u = new URL(url);
          const isLoopback =
            u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
          if (isLoopback) {
            const { PORT_RANGES } = require('../services/PortManager');
            const port = Number(u.port);
            if (Number.isFinite(port)) {
              // Check if port is in any allowed service range
              for (const [serviceName, range] of Object.entries(PORT_RANGES)) {
                if (port >= range.start && port <= range.end) {
                  callback({});
                  return;
                }
              }
            }
          }
        }
      } catch (err) {
        this.logger.debug('Failed to parse URL for loopback check, falling through to normal policy', { url, error: err?.message || String(err) });
        // fall through to normal policy
      }

      // Allow configured backend and service origins over HTTP (development)
      try {
        const config = require('../../core/config');
        const allowed = new Set();
        
        const addOriginWithLoopbackAliases = (rawUrl) => {
          if (!rawUrl || typeof rawUrl !== 'string') return;
          try {
            const origin = new URL(rawUrl).origin;
            allowed.add(origin);
            
            // Normalize loopback aliases to prevent false blocks:
            // - localhost ↔ 127.0.0.1
            // - ::1 → localhost/127.0.0.1
            const u = new URL(origin);
            if (u.hostname === '127.0.0.1') {
              u.hostname = 'localhost';
              allowed.add(u.origin);
            } else if (u.hostname === 'localhost') {
              u.hostname = '127.0.0.1';
              allowed.add(u.origin);
            } else if (u.hostname === '::1') {
              u.hostname = 'localhost';
              allowed.add(u.origin);
              u.hostname = '127.0.0.1';
              allowed.add(u.origin);
            }
          } catch (err) {
        this.logger.debug('Failed to parse URL for local service check', { url, error: err?.message || String(err) });
      }
        };
        
        // Backend - only URL needed for initial connection
        addOriginWithLoopbackAliases(config.backend.baseUrl);
        
        // NOTE: Services, LLM, and other origins come from backend /v1/settings/
        // Backend provides allowed_origins in security settings
        // Frontend config no longer has hardcoded service URLs
        // SecurityManager should fetch allowed origins from backend settings API
        // For now, backend.baseUrl covers backend-proxied services
        
        // NOTE: Do not hardcode additional localhost origins here.
        // Allowed HTTP origins must come from central config (backend baseUrl) or backend-provided settings.
        const isAllowedHttp = url.startsWith('http://') && Array.from(allowed).some(origin => url.startsWith(origin));
        if (isAllowedHttp) {
          callback({});
          return;
        }
      } catch (err) {
        this.logger.debug('Failed to evaluate allowed HTTP origins, falling through to security checks', { url, error: err?.message || String(err) });
        // fall through to security checks below
      }

      // Block other insecure protocols
      if (url.startsWith('http://') && this.profile.sandbox.webSecurity) {
        this.logger.warn('Blocked insecure HTTP request', { url });
        this._recordSecurityEvent('insecure-request-blocked', { url });
        callback({ cancel: true });
        return;
      }

      callback({});
    });

    // 4. Clear cache on startup (optional)
    if (this.options.clearCacheOnStartup) {
      await electronSession.clearCache();
      this.logger.info('Session cache cleared');
    }
  }

  /**
   * Set up security event handlers
   * @private
   */
  _setupSecurityEventHandlers() {
    // Monitor certificate errors
    app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
      this.logger.error('Certificate error', { url, error });
      this._recordSecurityEvent('certificate-error', { url, error });
      
      // Never allow certificate errors in production
      callback(false);
    });

    // Monitor login requests
    app.on('login', (event, webContents, authenticationResponseDetails, authInfo, callback) => {
      this.logger.warn('Login request intercepted', { authInfo });
      this._recordSecurityEvent('login-request', { authInfo });
      
      event.preventDefault();
      callback('', ''); // Deny login
    });
  }

  /**
   * Secure a BrowserWindow
   * @param {Electron.BrowserWindow} window - Window to secure
   * @param {Object} options - Additional security options
   */
  secureWindow(window, options = {}) {
    if (!window || window.isDestroyed()) {
      this.logger.warn('Cannot secure invalid window');
      return;
    }

    const windowId = window.id;
    this.logger.info('Securing window', { windowId });

    try {
      // 1. Attach external link handler
      this.externalLinkHandler.attach(window, options);

      // 2. Attach permission handler
      this.permissionHandler.attachToWindow(window);

      // 3. Monitor security events
      window.webContents.on('console-message', (event, level, message) => {
        if (message.includes('CSP') || message.includes('security')) {
          this.logger.warn('Security console message', { level, message });
          this._recordSecurityEvent('console-security-warning', { message });
        }
      });

      // 4. Monitor crashes
      window.webContents.on('render-process-gone', (event, details) => {
        this.logger.error('Renderer process crashed', { details });
        this._recordSecurityEvent('renderer-crash', { details });
      });

      this.logger.info('Window secured', { windowId });
    } catch (error) {
      this.logger.error('Failed to secure window', {
        windowId,
        error: error.message,
      });
    }
  }

  /**
   * Get BrowserWindow security preferences
   * @param {Object} customPrefs - Custom preferences to merge
   * @returns {Object} Secure preferences
   */
  getSecurePreferences(customPrefs = {}) {
    return {
      // Sandbox settings
      sandbox: this.profile.sandbox.enabled,
      nodeIntegration: this.profile.sandbox.nodeIntegration,
      contextIsolation: this.profile.sandbox.contextIsolation,
      webSecurity: this.profile.sandbox.webSecurity,
      allowRunningInsecureContent: this.profile.sandbox.allowRunningInsecureContent,
      experimentalFeatures: this.profile.sandbox.experimentalFeatures,
      enableBlinkFeatures: this.profile.sandbox.enableBlinkFeatures,
      disableBlinkFeatures: this.profile.sandbox.disableBlinkFeatures,
      
      // Additional security
      enableRemoteModule: false,
      enableWebSQL: false,
      spellcheck: true,
      v8CacheOptions: 'none',
      
      // Merge custom preferences
      ...customPrefs,
    };
  }

  /**
   * Run security audit
   * @returns {Object} Audit report
   */
  audit() {
    this.logger.info('Running security audit');

    const report = {
      timestamp: Date.now(),
      mode: this.options.mode,
      profile: this.options.profile,
      
      csp: {
        enabled: this.cspManager.enabled,
        policy: this.cspManager.buildPolicy(),
        violations: this.cspManager.getViolations().length,
      },
      
      sandbox: {
        ...this.profile.sandbox,
      },
      
      permissions: {
        policy: this.permissionHandler.getGlobalPolicy(),
      },
      
      events: {
        total: this.securityEvents.length,
        recent: this.securityEvents.slice(-10),
      },
      
      recommendations: this._generateRecommendations(),
    };

    this.logger.info('Security audit complete', { report });
    return Object.freeze(report);
  }

  /**
   * Generate security recommendations
   * @private
   */
  _generateRecommendations() {
    const recommendations = [];

    // Check CSP
    if (!this.cspManager.enabled) {
      recommendations.push({
        severity: 'high',
        category: 'csp',
        issue: 'CSP not enabled',
        suggestion: 'Enable Content Security Policy to prevent XSS attacks',
      });
    }

    // Check sandbox
    if (!this.profile.sandbox.enabled) {
      recommendations.push({
        severity: 'critical',
        category: 'sandbox',
        issue: 'Renderer sandbox disabled',
        suggestion: 'Enable sandbox for all renderer processes',
      });
    }

    // Check context isolation
    if (!this.profile.sandbox.contextIsolation) {
      recommendations.push({
        severity: 'critical',
        category: 'sandbox',
        issue: 'Context isolation disabled',
        suggestion: 'Enable contextIsolation to prevent prototype pollution',
      });
    }

    // Check node integration
    if (this.profile.sandbox.nodeIntegration) {
      recommendations.push({
        severity: 'critical',
        category: 'sandbox',
        issue: 'Node integration enabled',
        suggestion: 'Disable nodeIntegration in renderer processes',
      });
    }

    return recommendations;
  }

  /**
   * Record security event
   * @private
   */
  _recordSecurityEvent(type, data = {}) {
    const event = {
      type,
      timestamp: Date.now(),
      data,
    };

    this.securityEvents.push(event);

    // Trim events array
    if (this.securityEvents.length > this.maxEvents) {
      this.securityEvents.shift();
    }

    if (this.options.enableAuditing) {
      this.logger.warn('Security event', event);
    }
  }

  /**
   * Log security status
   * @private
   */
  _logSecurityStatus() {
    this.logger.info('='.repeat(80));
    this.logger.info('SECURITY STATUS');
    this.logger.info('='.repeat(80));
    this.logger.info('Mode:', this.options.mode);
    this.logger.info('CSP Enabled:', this.cspManager.enabled);
    this.logger.info('Sandbox Enabled:', this.profile.sandbox.enabled);
    this.logger.info('Context Isolation:', this.profile.sandbox.contextIsolation);
    this.logger.info('Node Integration:', this.profile.sandbox.nodeIntegration);
    this.logger.info('Web Security:', this.profile.sandbox.webSecurity);
    this.logger.info('='.repeat(80));
  }

  /**
   * Get security events
   * @param {Object} filter - Filter options
   * @returns {Array} Security events
   */
  getSecurityEvents(filter = {}) {
    let events = [...this.securityEvents];

    if (filter.type) {
      events = events.filter(e => e.type === filter.type);
    }

    if (filter.since) {
      events = events.filter(e => e.timestamp >= filter.since);
    }

    if (filter.limit) {
      events = events.slice(-filter.limit);
    }

    return events;
  }

  /**
   * Clear security events
   */
  clearSecurityEvents() {
    this.securityEvents = [];
    this.logger.info('Security events cleared');
  }

  /**
   * Shutdown security manager
   */
  shutdown() {
    this.logger.info('Shutting down SecurityManager');
    
    // Final audit
    if (this.options.enableAuditing) {
      const audit = this.audit();
      this.logger.info('Final security audit', { audit });
    }

    this.initialized = false;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalManager = null;

/**
 * Get or create global SecurityManager
 * @param {Object} options - Configuration options
 * @returns {SecurityManager}
 */
function getManager(options = {}) {
  if (!globalManager) {
    globalManager = new SecurityManager(options);
  }
  return globalManager;
}

/**
 * Create new SecurityManager instance
 * @param {Object} options - Configuration options
 * @returns {SecurityManager}
 */
function createManager(options = {}) {
  return new SecurityManager(options);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  SecurityManager,
  getManager,
  createManager,
  SECURITY_PROFILES,
};
