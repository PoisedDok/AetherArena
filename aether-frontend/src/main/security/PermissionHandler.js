'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron session.setPermissionRequestHandler/setPermissionCheckHandler (permission name, webContents, requestingOrigin) --- {electron_event, Event | string}
 * Processing: Check permission against DEFAULT_POLICIES (development/production modes), support per-window policy overrides via Map, attach to session or BrowserWindow, callback with allow/deny decision, log requests/denials, provide allow/deny/allowForWindow/denyForWindow helpers, PERMISSIONS enum (media, geolocation, notifications, clipboard, display-capture, serial, usb, hid, bluetooth, etc) --- {6 jobs: JOB_INITIALIZE, JOB_GET_STATE, JOB_EMIT_EVENT, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: session (permission callback), log output --- {void | boolean, void | boolean}
 * 
 * 
 * @module main/security/PermissionHandler
 * 
 * Permission Handler
 * ============================================================================
 * Manages Chromium permission requests (microphone, camera, geolocation, etc.)
 * with configurable policies per window.
 * 
 * Security features:
 * - Whitelisted permissions only
 * - Per-window permission policies
 * - Automatic denial of sensitive permissions in production
 * - Logging of all permission requests
 * 
 * @module main/security/PermissionHandler
 */

const { logger } = require('../../core/utils/logger');

/**
 * All possible Chromium permissions
 */
const PERMISSIONS = Object.freeze({
  MEDIA: 'media',                           // Camera and/or microphone
  GEOLOCATION: 'geolocation',               // Geographic location
  NOTIFICATIONS: 'notifications',           // Desktop notifications
  MIDI_SYSEX: 'midiSysex',                 // MIDI devices with sysex support
  POINTER_LOCK: 'pointerLock',             // Mouse pointer lock
  FULLSCREEN: 'fullscreen',                 // Fullscreen mode
  OPEN_EXTERNAL: 'openExternal',           // Open external protocols
  IDLE_DETECTION: 'idle-detection',        // Idle detection
  CLIPBOARD_READ: 'clipboard-read',        // Clipboard read
  CLIPBOARD_SANITIZED_WRITE: 'clipboard-sanitized-write', // Clipboard write
  DISPLAY_CAPTURE: 'display-capture',      // Screen capture
  SERIAL: 'serial',                        // Serial ports
  USB: 'usb',                              // USB devices
  HID: 'hid',                              // HID devices
  BLUETOOTH: 'bluetooth',                  // Bluetooth devices
});

/**
 * Default permission policies
 */
const DEFAULT_POLICIES = Object.freeze({
  // Development mode (permissive)
  development: {
    [PERMISSIONS.MEDIA]: true,
    [PERMISSIONS.GEOLOCATION]: false,
    [PERMISSIONS.NOTIFICATIONS]: true,
    [PERMISSIONS.MIDI_SYSEX]: false,
    [PERMISSIONS.POINTER_LOCK]: true,
    [PERMISSIONS.FULLSCREEN]: true,
    [PERMISSIONS.OPEN_EXTERNAL]: false,
    [PERMISSIONS.IDLE_DETECTION]: false,
    [PERMISSIONS.CLIPBOARD_READ]: true,
    [PERMISSIONS.CLIPBOARD_SANITIZED_WRITE]: true,
    [PERMISSIONS.DISPLAY_CAPTURE]: false,
    [PERMISSIONS.SERIAL]: false,
    [PERMISSIONS.USB]: false,
    [PERMISSIONS.HID]: false,
    [PERMISSIONS.BLUETOOTH]: false,
  },
  
  // Production mode (restrictive)
  production: {
    [PERMISSIONS.MEDIA]: true,              // Required for voice input
    [PERMISSIONS.GEOLOCATION]: false,
    [PERMISSIONS.NOTIFICATIONS]: false,
    [PERMISSIONS.MIDI_SYSEX]: false,
    [PERMISSIONS.POINTER_LOCK]: false,
    [PERMISSIONS.FULLSCREEN]: false,
    [PERMISSIONS.OPEN_EXTERNAL]: false,
    [PERMISSIONS.IDLE_DETECTION]: false,
    [PERMISSIONS.CLIPBOARD_READ]: false,
    [PERMISSIONS.CLIPBOARD_SANITIZED_WRITE]: true,
    [PERMISSIONS.DISPLAY_CAPTURE]: false,
    [PERMISSIONS.SERIAL]: false,
    [PERMISSIONS.USB]: false,
    [PERMISSIONS.HID]: false,
    [PERMISSIONS.BLUETOOTH]: false,
  },
});

// ============================================================================
// PermissionHandler Class
// ============================================================================

class PermissionHandler {
  constructor(options = {}) {
    this.options = {
      mode: options.mode || (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
      defaultPolicy: options.defaultPolicy || null,
      logRequests: options.logRequests !== false, // Default true
      logDenials: options.logDenials !== false,   // Default true
      ...options,
    };
    
    // Use provided policy or default based on mode (copy to allow mutations)
    const basePolicy = this.options.defaultPolicy || DEFAULT_POLICIES[this.options.mode] || DEFAULT_POLICIES.development;
    this.policy = { ...basePolicy };
    
    // Per-window overrides
    this.windowPolicies = new Map();
    
    this.logger = logger.child({ module: 'PermissionHandler' });
  }

  /**
   * Check if permission is allowed by policy
   * @param {string} permission - Permission name
   * @param {number} [windowId] - Window ID (for per-window policies)
   * @returns {boolean} True if allowed
   */
  isAllowed(permission, windowId = null) {
    // Check window-specific policy first
    if (windowId !== null && this.windowPolicies.has(windowId)) {
      const windowPolicy = this.windowPolicies.get(windowId);
      if (permission in windowPolicy) {
        return windowPolicy[permission];
      }
    }
    
    // Fall back to global policy
    return this.policy[permission] || false;
  }

  /**
   * Set per-window permission policy
   * @param {number} windowId - Window ID
   * @param {Object} policy - Permission policy
   */
  setWindowPolicy(windowId, policy) {
    this.windowPolicies.set(windowId, policy);
    this.logger.debug('Window policy set', { windowId, policy });
  }

  /**
   * Remove per-window permission policy
   * @param {number} windowId - Window ID
   */
  removeWindowPolicy(windowId) {
    this.windowPolicies.delete(windowId);
    this.logger.debug('Window policy removed', { windowId });
  }

  /**
   * Create permission request handler for a session
   * @param {Electron.Session} session - Electron session
   * @param {number} [windowId] - Window ID for logging
   * @returns {void}
   */
  attachToSession(session, windowId = null) {
    if (!session) {
      this.logger.warn('Attempted to attach to invalid session');
      return;
    }
    
    const sessionLogger = windowId !== null
      ? this.logger.child({ windowId })
      : this.logger;
    
    // Handle permission requests
    session.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = this.isAllowed(permission, windowId);
      
      if (this.options.logRequests) {
        sessionLogger.info('Permission requested', {
          permission,
          allowed,
          url: webContents.getURL(),
        });
      }
      
      if (!allowed && this.options.logDenials) {
        sessionLogger.warn('Permission denied', {
          permission,
          url: webContents.getURL(),
        });
      }
      
      callback(allowed);
    });
    
    // Handle permission check requests (for APIs like clipboard)
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      const allowed = this.isAllowed(permission, windowId);
      
      if (this.options.logRequests) {
        sessionLogger.debug('Permission checked', {
          permission,
          allowed,
          origin: requestingOrigin,
        });
      }
      
      return allowed;
    });
    
    sessionLogger.info('Permission handler attached to session');
  }

  /**
   * Attach to a BrowserWindow (uses window's session)
   * @param {Electron.BrowserWindow} window - Window to attach to
   */
  attachToWindow(window) {
    if (!window || window.isDestroyed()) {
      this.logger.warn('Attempted to attach to invalid window');
      return;
    }
    
    const session = window.webContents.session;
    this.attachToSession(session, window.id);
    
    // Clean up window policy when window is closed
    window.once('closed', () => {
      this.removeWindowPolicy(window.id);
    });
  }

  /**
   * Set global permission policy
   * @param {Object} policy - New global policy
   */
  setGlobalPolicy(policy) {
    this.policy = { ...this.policy, ...policy };
    this.logger.info('Global policy updated', { policy: this.policy });
  }

  /**
   * Allow a specific permission globally
   * @param {string} permission - Permission to allow
   */
  allow(permission) {
    this.policy[permission] = true;
    this.logger.info('Permission globally allowed', { permission });
  }

  /**
   * Deny a specific permission globally
   * @param {string} permission - Permission to deny
   */
  deny(permission) {
    this.policy[permission] = false;
    this.logger.info('Permission globally denied', { permission });
  }

  /**
   * Allow a permission for a specific window
   * @param {number} windowId - Window ID
   * @param {string} permission - Permission to allow
   */
  allowForWindow(windowId, permission) {
    const windowPolicy = this.windowPolicies.get(windowId) || {};
    windowPolicy[permission] = true;
    this.windowPolicies.set(windowId, windowPolicy);
    this.logger.info('Permission allowed for window', { windowId, permission });
  }

  /**
   * Deny a permission for a specific window
   * @param {number} windowId - Window ID
   * @param {string} permission - Permission to deny
   */
  denyForWindow(windowId, permission) {
    const windowPolicy = this.windowPolicies.get(windowId) || {};
    windowPolicy[permission] = false;
    this.windowPolicies.set(windowId, windowPolicy);
    this.logger.info('Permission denied for window', { windowId, permission });
  }

  /**
   * Get current policy (global)
   * @returns {Object} Current policy
   */
  getGlobalPolicy() {
    return { ...this.policy };
  }

  /**
   * Get policy for a specific window
   * @param {number} windowId - Window ID
   * @returns {Object} Window policy (merged with global)
   */
  getWindowPolicy(windowId) {
    const windowPolicy = this.windowPolicies.get(windowId) || {};
    return { ...this.policy, ...windowPolicy };
  }

  /**
   * Reset to default policy
   * @param {string} [mode] - Mode to reset to (development/production)
   */
  resetToDefault(mode = null) {
    const targetMode = mode || this.options.mode;
    this.policy = { ...DEFAULT_POLICIES[targetMode] };
    this.logger.info('Policy reset to default', { mode: targetMode });
  }

  /**
   * Clear all window-specific policies
   */
  clearWindowPolicies() {
    this.windowPolicies.clear();
    this.logger.info('All window policies cleared');
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalHandler = null;

/**
 * Get or create global handler instance
 * @param {Object} options - Configuration options
 * @returns {PermissionHandler} Handler instance
 */
function getHandler(options = {}) {
  if (!globalHandler) {
    globalHandler = new PermissionHandler(options);
  }
  return globalHandler;
}

/**
 * Create a new handler instance
 * @param {Object} options - Configuration options
 * @returns {PermissionHandler} New handler instance
 */
function createHandler(options = {}) {
  return new PermissionHandler(options);
}

/**
 * Attach permission handler to a window (convenience)
 * @param {Electron.BrowserWindow} window - Window to attach to
 * @param {Object} [windowPolicy] - Optional window-specific policy
 */
function attachToWindow(window, windowPolicy = null) {
  const handler = getHandler();
  
  if (windowPolicy) {
    handler.setWindowPolicy(window.id, windowPolicy);
  }
  
  handler.attachToWindow(window);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  PermissionHandler,
  getHandler,
  createHandler,
  attachToWindow,
  
  // Constants
  PERMISSIONS,
  DEFAULT_POLICIES,
};

