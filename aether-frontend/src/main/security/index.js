'use strict';

/**
 * @module main/security/index
 * 
 * Main Security Module
 * ============================================================================
 * Central export for all main process security components
 * 
 * Re-exports: SecurityManager, ExternalLinkHandler, PermissionHandler 
 * with factory functions and constants for centralized import path.
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
