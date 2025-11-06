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
    // Try to load from main process
    const mainModule = require('../../main/index');
    portManagerCache = mainModule.getPortManager();
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
function getBackendUrl(defaultUrl = 'http://localhost:8765') {
  const portManager = getPortManager();
  
  if (portManager) {
    return portManager.getServiceUrl('backend', defaultUrl);
  }
  
  return defaultUrl;
}

/**
 * Get service URL with dynamic discovery fallback
 * @param {string} serviceName - Service name (perplexica, searxng, docling, xlwings, llm)
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
    return 'ws://localhost:8765';
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
    return service && service.healthy;
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

