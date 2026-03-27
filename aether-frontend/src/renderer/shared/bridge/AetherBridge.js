'use strict';

/**
 * @.architecture
 *
 * Incoming: Renderer modules requesting preload APIs --- {method_call, javascript_api}
 * Processing: Provide a single access point for window.aether with safety checks --- {2 jobs: JOB_GET_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: aether bridge object or null --- {object|null}
 *
 * @module renderer/shared/bridge/AetherBridge
 */

// NOTE: AetherBridge MUST NOT import logger.js at module scope.
// logger.js -> AetherBridge.js creates a circular dependency that causes
// createRendererLogger to be undefined during module initialization.
// AetherBridge is the lowest-level bridge — it uses console directly.

function getAether() {
  const bridge = typeof window !== 'undefined' ? window.aether : null;
  if (!bridge) {
    console.debug('[AetherBridge] window.aether not available');
  }
  return bridge;
}

function requireAether() {
  const bridge = getAether();
  if (!bridge) {
    throw new Error('[AetherBridge] window.aether is required but not available');
  }
  return bridge;
}

module.exports = {
  getAether,
  requireAether,
};
