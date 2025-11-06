'use strict';

/**
 * @.architecture
 * 
 * Incoming: BrowserWindow (attach method), webContents events (will-navigate, setWindowOpenHandler, did-create-window) --- {electron_event, Event | string}
 * Processing: Validate URLs against ALLOWED_SCHEMES (file, about, devtools for in-app), EXTERNAL_SCHEMES (http, https, mailto, tel for shell.openExternal), BLOCKED_PATTERNS (javascript, data, vbscript, path traversal), prevent will-navigate/window.open for external URLs, open via shell.openExternal, attach to BrowserWindow recursively (child windows), provide createClickHandler for renderer --- {5 jobs: JOB_INITIALIZE, JOB_VALIDATE_SCHEMA, JOB_ROUTE_BY_TYPE, JOB_INITIALIZE, JOB_EMIT_EVENT}
 * Outgoing: shell.openExternal (system browser), BrowserWindow (attached listeners) --- {void | electron_action, void}
 * 
 * 
 * @module main/security/ExternalLinkHandler
 * 
 * External Link Handler
 * ============================================================================
 * Prevents in-app navigation to external URLs and opens them in system browser.
 * Protects against:
 * - Phishing attacks via navigation hijacking
 * - XSS via window.open
 * - Unauthorized external content loading
 * 
 * @module main/security/ExternalLinkHandler
 */

const { shell } = require('electron');
const { logger } = require('../../core/utils/logger');

/**
 * URL schemes allowed for in-app navigation
 */
const ALLOWED_SCHEMES = Object.freeze([
  'file:',
  'about:',
  'devtools:',
]);

/**
 * URL schemes allowed to be opened externally
 */
const EXTERNAL_SCHEMES = Object.freeze([
  'http:',
  'https:',
  'mailto:',
  'tel:',
]);

/**
 * URL patterns to block entirely (security risks)
 */
const BLOCKED_PATTERNS = Object.freeze([
  /^javascript:/i,
  /^data:/i,
  /^vbscript:/i,
  /^file:\/\/.*\.\.(\/|\\)/i, // Path traversal in file URLs
]);

// ============================================================================
// ExternalLinkHandler Class
// ============================================================================

class ExternalLinkHandler {
  constructor(options = {}) {
    this.options = {
      allowedSchemes: options.allowedSchemes || ALLOWED_SCHEMES,
      externalSchemes: options.externalSchemes || EXTERNAL_SCHEMES,
      blockedPatterns: options.blockedPatterns || BLOCKED_PATTERNS,
      openExternal: options.openExternal !== false, // Default true
      logBlocked: options.logBlocked !== false, // Default true
      ...options,
    };
    
    this.logger = logger.child({ module: 'ExternalLinkHandler' });
  }

  /**
   * Check if URL is allowed for in-app navigation
   * @param {string} url - URL to check
   * @returns {boolean} True if allowed
   */
  isAllowedScheme(url) {
    if (!url || typeof url !== 'string') return false;
    
    try {
      const urlObj = new URL(url);
      return this.options.allowedSchemes.includes(urlObj.protocol);
    } catch {
      return false;
    }
  }

  /**
   * Check if URL can be opened externally
   * @param {string} url - URL to check
   * @returns {boolean} True if can be opened externally
   */
  isExternalScheme(url) {
    if (!url || typeof url !== 'string') return false;
    
    try {
      const urlObj = new URL(url);
      return this.options.externalSchemes.includes(urlObj.protocol);
    } catch {
      return false;
    }
  }

  /**
   * Check if URL matches blocked patterns
   * @param {string} url - URL to check
   * @returns {boolean} True if blocked
   */
  isBlocked(url) {
    if (!url || typeof url !== 'string') return false;
    
    return this.options.blockedPatterns.some(pattern => pattern.test(url));
  }

  /**
   * Determine action for URL
   * @param {string} url - URL to check
   * @returns {string} Action: 'allow', 'external', 'block'
   */
  determineAction(url) {
    // Check blocked patterns first (highest priority)
    if (this.isBlocked(url)) {
      return 'block';
    }
    
    // Check if allowed for in-app navigation
    if (this.isAllowedScheme(url)) {
      return 'allow';
    }
    
    // Check if can be opened externally
    if (this.isExternalScheme(url)) {
      return 'external';
    }
    
    // Default: block unknown schemes
    return 'block';
  }

  /**
   * Open URL externally in system browser
   * @param {string} url - URL to open
   * @returns {Promise<void>}
   */
  async openExternal(url) {
    if (!this.options.openExternal) {
      this.logger.warn('External URL opening disabled', { url });
      return;
    }
    
    if (!this.isExternalScheme(url)) {
      this.logger.warn('Attempted to open non-external URL', { url });
      return;
    }
    
    try {
      this.logger.info('Opening external URL', { url });
      await shell.openExternal(url);
    } catch (err) {
      this.logger.error('Failed to open external URL', { url, error: err.message });
    }
  }

  /**
   * Attach external link protection to a BrowserWindow
   * @param {Electron.BrowserWindow} window - Window to protect
   * @param {Object} options - Options
   * @returns {void}
   */
  attach(window, options = {}) {
    if (!window || window.isDestroyed()) {
      this.logger.warn('Attempted to attach to invalid window');
      return;
    }
    
    const webContents = window.webContents;
    const windowId = window.id;
    const windowLogger = this.logger.child({ windowId });
    
    // Handle window.open() and <a target="_blank">
    webContents.setWindowOpenHandler(({ url }) => {
      const action = this.determineAction(url);
      
      switch (action) {
        case 'external':
          windowLogger.debug('Opening external link from window.open', { url });
          this.openExternal(url).catch(() => {});
          return { action: 'deny' };
        
        case 'allow':
          windowLogger.debug('Allowing window.open', { url });
          return { action: 'allow' };
        
        case 'block':
        default:
          if (this.options.logBlocked) {
            windowLogger.warn('Blocked window.open', { url });
          }
          return { action: 'deny' };
      }
    });
    
    // Handle navigation attempts (e.g., clicks, redirects)
    webContents.on('will-navigate', (event, url) => {
      const action = this.determineAction(url);
      
      switch (action) {
        case 'external':
          event.preventDefault();
          windowLogger.debug('Opening external link from navigation', { url });
          this.openExternal(url).catch(() => {});
          break;
        
        case 'allow':
          windowLogger.debug('Allowing navigation', { url });
          break;
        
        case 'block':
        default:
          event.preventDefault();
          if (this.options.logBlocked) {
            windowLogger.warn('Blocked navigation', { url });
          }
          break;
      }
    });
    
    // Handle iframe navigation attempts
    webContents.on('did-create-window', (childWindow) => {
      windowLogger.debug('Child window created', { childId: childWindow.id });
      // Attach protection to child windows too
      this.attach(childWindow, options);
    });
    
    windowLogger.info('External link protection attached');
  }

  /**
   * Detach external link protection from a window
   * @param {Electron.BrowserWindow} window - Window to detach from
   */
  detach(window) {
    if (!window || window.isDestroyed()) return;
    
    const webContents = window.webContents;
    
    // Remove all listeners (Electron doesn't provide removeListener for these)
    // The listeners will be garbage collected when window is destroyed
    
    this.logger.debug('External link protection detached', { windowId: window.id });
  }

  /**
   * Create a safe click handler for renderer process
   * Returns a function that can be used in preload scripts
   * @returns {Function} Click handler function
   */
  createClickHandler() {
    return (event) => {
      try {
        // Find closest <a> tag
        let target = event.target;
        while (target && target.tagName !== 'A') {
          target = target.parentElement;
        }
        
        if (!target) return;
        
        const href = target.getAttribute('href');
        if (!href) return;
        
        // Check if external link
        if (href.startsWith('http://') || href.startsWith('https://')) {
          event.preventDefault();
          
          // Send to main process to open externally
          if (typeof window !== 'undefined' && window.aether?.ipc) {
            window.aether.ipc.send('open-external-url', href);
          }
        }
      } catch (err) {
        console.error('Click handler error:', err);
      }
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalHandler = null;

/**
 * Get or create global handler instance
 * @param {Object} options - Configuration options
 * @returns {ExternalLinkHandler} Handler instance
 */
function getHandler(options = {}) {
  if (!globalHandler) {
    globalHandler = new ExternalLinkHandler(options);
  }
  return globalHandler;
}

/**
 * Create a new handler instance
 * @param {Object} options - Configuration options
 * @returns {ExternalLinkHandler} New handler instance
 */
function createHandler(options = {}) {
  return new ExternalLinkHandler(options);
}

/**
 * Attach external link protection to a window (convenience)
 * @param {Electron.BrowserWindow} window - Window to protect
 * @param {Object} options - Options
 */
function attachToWindow(window, options = {}) {
  const handler = getHandler(options);
  handler.attach(window, options);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ExternalLinkHandler,
  getHandler,
  createHandler,
  attachToWindow,
  
  // Constants
  ALLOWED_SCHEMES,
  EXTERNAL_SCHEMES,
  BLOCKED_PATTERNS,
};

