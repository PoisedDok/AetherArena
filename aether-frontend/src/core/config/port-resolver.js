'use strict';

/**
 * @.architecture
 * 
 * Incoming: Configuration modules (resolvers.js), ApiClient, Endpoint (getBackendUrl calls) --- {request_types.get_service_url, method_call}
 * Processing: Lazy-load PortManager from main process, query discovered service URLs, fallback to defaults if unavailable, convert HTTP to WebSocket URLs, check service health --- {3 jobs: JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_ROUTE_BY_TYPE}
 * Outgoing: Return service URL string (discovered or fallback) --- {service_types.url, string}
 * 
 * 
 * @module core/config/port-resolver
 */

const DEFAULTS = require('./defaults');

/**
 * Cached port manager reference (lazy loaded from main process)
 */
let portManagerCache = null;

/**
 * Get port manager instance
 * Only available in main process
 */
function getPortManager() {
  if (portManagerCache) {
    return portManagerCache;
  }
  
  try {
    // Only available in Electron main process. Avoid circular require on `main/index.js`.
    // - In renderer: process.type === 'renderer'
    // - In node tests: process.versions.electron is usually undefined
    if (!process?.versions?.electron || process?.type !== 'browser') {
      return null;
    }
    const { getManager } = require('../../main/services/PortManager');
    portManagerCache = getManager();
    return portManagerCache;
  } catch (err) {
    // Not available (renderer process or before initialization)
    return null;
  }
}

/**
 * Get backend URL with dynamic discovery fallback
 * @param {string} defaultUrl - Fallback URL
 * @returns {string} Backend URL
 */
function getBackendUrl(defaultUrl = DEFAULTS.backend.baseUrl) {
  const portManager = getPortManager();

  // If PortManager is available and has a healthy backend, use the discovered URL.
  if (portManager) {
    try {
      const backend = portManager.getService && portManager.getService('backend');
      if (backend && backend.healthy && backend.url) {
        return backend.url;
      }
    } catch (err) {
      // ignore and fall through
    }
  }

  // During cold start the backend takes 30-60s. PortManager won't have a healthy service yet.
  // Return the default/configured URL so callers (StorageHandler, MemoryHandler, IPC router)
  // can initialise their base URLs. Requests will fail until the backend binds, which is handled
  // by the renderer's onboarding health-polling gate and connection overlay retry logic.
  if (portManager && defaultUrl && typeof defaultUrl === 'string' && defaultUrl.trim().length > 0) {
    return portManager.getServiceUrl('backend', defaultUrl);
  }

  if (!defaultUrl || typeof defaultUrl !== 'string' || defaultUrl.trim().length === 0) {
    throw new Error('[PortResolver] CONTRACT VIOLATION: Backend URL is not configured and no healthy backend was discovered. Set GURU_API_URL/backend_url or start the backend so PortManager can discover it.');
  }

  return defaultUrl;
}

/**
 * Get service URL with dynamic discovery fallback
 * @param {string} serviceName - Service name (perplexica, searxng, docling, llm)
 * @param {string} defaultUrl - Fallback URL
 * @returns {string} Service URL
 */
function getServiceUrl(serviceName, defaultUrl) {
  const portManager = getPortManager();
  
  if (portManager) {
    return portManager.getServiceUrl(serviceName, defaultUrl);
  }
  
  return defaultUrl;
}

/**
 * Get WebSocket URL for backend
 * Converts HTTP URL to WebSocket URL
 * @param {string} httpUrl - HTTP URL
 * @returns {string} WebSocket URL
 */
function getBackendWsUrl(httpUrl) {
  if (!httpUrl) {
    throw new Error('[PortResolver] CONTRACT VIOLATION: httpUrl is required for getBackendWsUrl(). Backend URL must be configured or discovered.');
  }
  
  // Convert http:// to ws:// or https:// to wss://
  return httpUrl.replace(/^http/, 'ws');
}

/**
 * Check if a service is discovered and healthy
 * @param {string} serviceName - Service name
 * @returns {boolean} True if service is healthy
 */
function isServiceHealthy(serviceName) {
  const portManager = getPortManager();
  
  if (portManager) {
    const service = portManager.getService(serviceName);
    return !!(service && service.healthy);
  }
  
  return false;
}

/**
 * Get all discovered services
 * @returns {Array<Object>} List of services with { name, url, healthy, port }
 */
function getAllServices() {
  const portManager = getPortManager();
  
  if (portManager) {
    return portManager.getHealthyServices();
  }
  
  return [];
}

/**
 * Clear port manager cache (for testing)
 */
function clearCache() {
  portManagerCache = null;
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  getBackendUrl,
  getServiceUrl,
  getBackendWsUrl,
  isServiceHealthy,
  getAllServices,
  clearCache,
};
