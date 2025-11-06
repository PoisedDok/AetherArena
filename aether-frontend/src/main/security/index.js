'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export SecurityManager (CSP + sandbox + permissions + auditing), ExternalLinkHandler (will-navigate + window.open protection), PermissionHandler (Electron permissions) with factory functions (getManager, createManager, getHandler, createHandler, attachToWindow) and constants (SECURITY_PROFILES, ALLOWED_SCHEMES, EXTERNAL_SCHEMES, BLOCKED_PATTERNS, PERMISSIONS, DEFAULT_POLICIES) --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: main/*, main/windows/* (security components) --- {module_exports, javascript_object}
 * 
 * 
 * @module main/security/index
 * 
 * Main Security Module
 * ============================================================================
 * Central export for all main process security components
 * 
 * @module main/security
 */

const {
  SecurityManager,
  getManager,
  createManager,
  SECURITY_PROFILES,
} = require('./SecurityManager');

const {
  ExternalLinkHandler,
  getHandler: getExternalLinkHandler,
  createHandler: createExternalLinkHandler,
  attachToWindow: attachExternalLinkHandler,
  ALLOWED_SCHEMES,
  EXTERNAL_SCHEMES,
  BLOCKED_PATTERNS,
} = require('./ExternalLinkHandler');

const {
  PermissionHandler,
  getHandler: getPermissionHandler,
  createHandler: createPermissionHandler,
  attachToWindow: attachPermissionHandler,
  PERMISSIONS,
  DEFAULT_POLICIES,
} = require('./PermissionHandler');

// Export all security components
module.exports = {
  // Security Manager
  SecurityManager,
  getManager,
  createManager,
  SECURITY_PROFILES,
  
  // External Link Handler
  ExternalLinkHandler,
  getExternalLinkHandler,
  createExternalLinkHandler,
  attachExternalLinkHandler,
  ALLOWED_SCHEMES,
  EXTERNAL_SCHEMES,
  BLOCKED_PATTERNS,
  
  // Permission Handler
  PermissionHandler,
  getPermissionHandler,
  createPermissionHandler,
  attachPermissionHandler,
  PERMISSIONS,
  DEFAULT_POLICIES,
};


