'use strict';

/**
 * @.architecture
 * 
 * Incoming: Bootstrap scripts (.register() calls), modules (.resolve() calls) --- {request_types.register_service | request_types.resolve_service, method_call}
 * Processing: Maintain services Map (name → factory config), maintain singletons cache (name → instance), resolve dependencies recursively, detect circular dependencies via _creating Set, validate instances, dispose in reverse order --- {6 jobs: JOB_INITIALIZE, JOB_GET_STATE, JOB_GET_STATE, JOB_GET_STATE, JOB_CACHE_LOCALLY, JOB_DISPOSE}
 * Outgoing: Return service instances (singletons or transient) --- {service_instance, javascript_object}
 * 
 * 
 * @module core/di/Container
 */

const { freeze, seal } = Object;

class DependencyContainer {
  constructor(options = {}) {
    this._services = new Map();
    this._singletons = new Map();
    this._creating = new Set();
    this._disposed = false;
    this.name = options.name || 'default';
    this.enableLogging = options.enableLogging || false;
  }

  /**
   * Register a service
   * @param {string} name - Service identifier
   * @param {Function} factory - Factory function to create service
   * @param {Object} options - Configuration options
   */
  register(name, factory, options = {}) {
    if (this._disposed) {
      throw new Error(`[DI:${this.name}] Cannot register after disposal`);
    }

    if (typeof name !== 'string' || !name) {
      throw new TypeError('Service name must be a non-empty string');
    }

    if (typeof factory !== 'function') {
      throw new TypeError('Factory must be a function');
    }

    if (this._services.has(name)) {
      throw new Error(`[DI:${this.name}] Service "${name}" already registered`);
    }

    this._services.set(name, seal({
      factory,
      singleton: options.singleton !== false,
      dependencies: Array.isArray(options.dependencies) ? options.dependencies : [],
      metadata: options.metadata || {},
    }));

    if (this.enableLogging) {
      console.log(`[DI:${this.name}] Registered "${name}" (${options.singleton !== false ? 'singleton' : 'transient'})`);
    }
  }

  /**
   * Resolve a service by name
   * @param {string} name - Service identifier
   * @returns {*} Service instance
   */
  resolve(name) {
    if (this._disposed) {
      throw new Error(`[DI:${this.name}] Cannot resolve after disposal`);
    }

    if (typeof name !== 'string' || !name) {
      throw new TypeError('Service name must be a non-empty string');
    }

    const service = this._services.get(name);
    if (!service) {
      const available = Array.from(this._services.keys()).join(', ');
      throw new Error(`[DI:${this.name}] Service "${name}" not registered. Available: [${available}]`);
    }

    // Return cached singleton
    if (service.singleton && this._singletons.has(name)) {
      return this._singletons.get(name);
    }

    // Detect circular dependencies
    if (this._creating.has(name)) {
      const chain = Array.from(this._creating).join(' → ');
      throw new Error(`[DI:${this.name}] Circular dependency detected: ${chain} → ${name}`);
    }

    try {
      this._creating.add(name);

      // Resolve dependencies recursively
      const deps = service.dependencies.map(dep => this.resolve(dep));
      
      // Create instance
      const instance = service.factory(...deps);

      // Validate instance
      if (instance === undefined || instance === null) {
        throw new Error(`[DI:${this.name}] Factory for "${name}" returned ${instance}`);
      }

      // Cache singleton
      if (service.singleton) {
        this._singletons.set(name, instance);
      }

      if (this.enableLogging) {
        console.log(`[DI:${this.name}] Resolved "${name}"`);
      }

      return instance;

    } catch (error) {
      console.error(`[DI:${this.name}] Failed to resolve "${name}":`, error);
      throw error;
    } finally {
      this._creating.delete(name);
    }
  }

  /**
   * Check if service is registered
   * @param {string} name - Service identifier
   * @returns {boolean}
   */
  has(name) {
    return this._services.has(name);
  }

  /**
   * Get all registered service names
   * @returns {string[]}
   */
  getServiceNames() {
    return Array.from(this._services.keys());
  }

  /**
   * Get service metadata
   * @param {string} name - Service identifier
   * @returns {Object|null}
   */
  getMetadata(name) {
    const service = this._services.get(name);
    return service ? { ...service.metadata } : null;
  }

  /**
   * Dispose all singletons and clear container
   */
  dispose() {
    if (this._disposed) return;

    if (this.enableLogging) {
      console.log(`[DI:${this.name}] Disposing ${this._singletons.size} singletons...`);
    }

    // Dispose in reverse order of creation
    const singletons = Array.from(this._singletons.entries()).reverse();
    
    for (const [name, instance] of singletons) {
      if (instance && typeof instance.dispose === 'function') {
        try {
          instance.dispose();
          if (this.enableLogging) {
            console.log(`[DI:${this.name}] Disposed "${name}"`);
          }
        } catch (error) {
          console.error(`[DI:${this.name}] Failed to dispose "${name}":`, error);
        }
      }
    }

    this._singletons.clear();
    this._creating.clear();
    this._disposed = true;

    if (this.enableLogging) {
      console.log(`[DI:${this.name}] Container disposed`);
    }
  }

  /**
   * Reset container (dispose + clear registrations)
   */
  reset() {
    this.dispose();
    this._services.clear();
    this._disposed = false;

    if (this.enableLogging) {
      console.log(`[DI:${this.name}] Container reset`);
    }
  }

  /**
   * Get container statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      name: this.name,
      registered: this._services.size,
      singletons: this._singletons.size,
      creating: this._creating.size,
      disposed: this._disposed,
    });
  }

  /**
   * List all registered services (alias for getServiceNames - for tests)
   * @returns {string[]}
   */
  list() {
    return this.getServiceNames();
  }
}

// Export
module.exports = { DependencyContainer };

if (typeof window !== 'undefined') {
  window.DependencyContainer = DependencyContainer;
  console.log('📦 DependencyContainer loaded');
}

