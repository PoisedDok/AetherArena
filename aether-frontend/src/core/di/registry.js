'use strict';

/**
 * @.architecture
 * 
 * Incoming: All bootstrap scripts (.getContainer() calls) --- {request_types.get_container, method_call}
 * Processing: Export singleton Container instance, provide factory for scoped containers --- {2 jobs: JOB_GET_STATE, JOB_INITIALIZE}
 * Outgoing: Return DependencyContainer instances (global or scoped) --- {service_types.dependency_container, DependencyContainer}
 * 
 * 
 * @module core/di/registry
 * 
 * Global Service Registry
 * ============================================================================
 * Provides global access to the main DI container.
 * All renderers should use this registry for service management.
 */

const { DependencyContainer } = require('./Container');

// Global container instance
const globalContainer = new DependencyContainer({
  name: 'global',
  enableLogging: false
});

/**
 * Get the global container
 * @returns {DependencyContainer}
 */
function getContainer() {
  return globalContainer;
}

/**
 * Create a scoped container (inherits from global)
 * @param {string} name - Container name
 * @param {Object} options - Configuration options
 * @returns {DependencyContainer}
 */
function createScopedContainer(name, options = {}) {
  return new DependencyContainer({
    name,
    ...options
  });
}

// Export
module.exports = {
  getContainer,
  createScopedContainer,
  DependencyContainer
};

if (typeof window !== 'undefined') {
  window.__DI_CONTAINER__ = globalContainer;
  window.getContainer = getContainer;
  window.createScopedContainer = createScopedContainer;
  console.log('📦 DI Registry loaded');
}

