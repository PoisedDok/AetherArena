'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron app/session events (web-contents-created, certificate-error, login), BrowserWindow (secureWindow method) --- {electron_event, Event | BrowserWindow}
 * Processing: Orchestrate CSP (CspManager via meta tag + HTTP headers), renderer sandboxing (nodeIntegration=false, contextIsolation=true, webSecurity=true), external link protection (ExternalLinkHandler), permission management (PermissionHandler), security auditing (record events), configure session.webRequest (CSP headers, block insecure HTTP except localhost, X-Content-Type-Options, X-Frame-Options, X-XSS-Protection), inject CSP on did-finish-load, prevent will-navigate/window.open via _secureWebContents, monitor console/crashes, provide SECURITY_PROFILES (strict/default) --- {12 jobs: JOB_INITIALIZE, JOB_GET_STATE, JOB_DELEGATE_TO_MODULE, JOB_UPDATE_STATE, JOB_INITIALIZE, JOB_EMIT_EVENT, JOB_TRACK_ENTITY, JOB_ROUTE_BY_TYPE, JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA, JOB_DISPOSE, JOB_VALIDATE_SCHEMA}
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
      // 1. Inject CSP meta tag for file:// protocol
      // Note: CSP meta tags cannot enforce all directives (frame-ancestors is ignored)
      // This is expected behavior - meta tags are secondary to HTTP headers
      if (this.cspManager.enabled) {
        const cspPolicy = this.cspManager.buildPolicy();
        const cspHeaderName = this.cspManager.getHeaderName();
        
        contents.executeJavaScript(`
          (function() {
            try {
              // Remove existing CSP meta tags
              const existing = document.querySelectorAll('meta[http-equiv*="Content-Security-Policy"]');
              existing.forEach(el => el.remove());
              
              // Create new CSP meta tag
              const meta = document.createElement('meta');
              meta.setAttribute('http-equiv', '${cspHeaderName}');
              meta.setAttribute('content', ${JSON.stringify(cspPolicy)});
              
              // Insert at beginning of head
              if (document.head.firstChild) {
                document.head.insertBefore(meta, document.head.firstChild);
              } else {
                document.head.appendChild(meta);
              }
              
              // Note: frame-ancestors warning is expected - ignored in meta tags per CSP spec
            } catch (err) {
              console.error('[SecurityManager] Failed to inject CSP:', err);
            }
          })();
        `).catch((err) => {
          this.logger.error('Failed to inject CSP', { error: err.message });
        });
      }
      
      // 2. Prevent WebRTC IP leak
      if (this.options.preventWebRTCLeak) {
        contents.executeJavaScript(`
          if (typeof RTCPeerConnection !== 'undefined') {
            const OriginalRTCPeerConnection = RTCPeerConnection;
            RTCPeerConnection = function() {
              throw new Error('WebRTC disabled for security');
            };
          }
        `).catch(() => {});
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
      
      if (this.cspManager.enabled) {
        const cspHeader = this.cspManager.getHeader();
        headers[cspHeader.name] = [cspHeader.value];
      }

      // Security headers
      headers['X-Content-Type-Options'] = ['nosniff'];
      headers['X-Frame-Options'] = ['DENY'];
      headers['X-XSS-Protection'] = ['1; mode=block'];
      headers['Referrer-Policy'] = ['no-referrer'];
      headers['Permissions-Policy'] = ['geolocation=(), microphone=(), camera=()'];

      callback({ responseHeaders: headers });
    });

    // 3. Block insecure content
    electronSession.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;
      
      // Allow localhost HTTP for development/local backend
      if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
        callback({});
        return;
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

      // 3. Inject CSP if needed
      if (this.cspManager.enabled && options.injectCsp !== false) {
        window.webContents.on('did-finish-load', () => {
          window.webContents.executeJavaScript(`
            if (typeof document !== 'undefined') {
              const meta = document.createElement('meta');
              meta.httpEquiv = 'Content-Security-Policy';
              meta.content = ${JSON.stringify(this.cspManager.buildPolicy())};
              document.head.prepend(meta);
            }
          `).catch(err => {
            this.logger.error('Failed to inject CSP', { error: err.message });
          });
        });
      }

      // 4. Monitor security events
      window.webContents.on('console-message', (event, level, message) => {
        if (message.includes('CSP') || message.includes('security')) {
          this.logger.warn('Security console message', { level, message });
          this._recordSecurityEvent('console-security-warning', { message });
        }
      });

      // 5. Monitor crashes
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
      spellcheck: false,
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


