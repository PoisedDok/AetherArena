'use strict';

/**
 * @.architecture
 * 
 * Incoming: Configuration/settings modules (.set/.get/.remove/.has/.clear calls) --- {method_calls, javascript_api}
 * Processing: Wrap localStorage with namespace (prefix keys with 'aether:'), JSON serialize/deserialize with metadata (value/timestamp/version), handle QuotaExceededError with automatic cleanup (remove oldest 25%), fallback to in-memory Map if localStorage unavailable, availability check on construction --- {7 jobs: JOB_GET_STATE, JOB_STRINGIFY_JSON, JOB_PARSE_JSON, JOB_ROUTE_BY_TYPE, JOB_DISPOSE, JOB_GET_STATE, JOB_GET_STATE}
 * Outgoing: Return data (get), boolean success (set/remove/clear) --- {any | boolean, any}
 * 
 * 
 * @module infrastructure/persistence/LocalStorage
 * 
 * LocalStorage - Browser localStorage wrapper
 * ============================================================================
 * Production-grade localStorage wrapper with:
 * - Type-safe get/set operations
 * - JSON serialization/deserialization
 * - Error handling and fallback
 * - Storage quota management
 * - Namespace support
 * 
 * Used for:
 * - Configuration overrides
 * - UI preferences
 * - Temporary cache
 * - Fallback when backend unavailable
 */

const { freeze } = Object;

class LocalStorage {
  constructor(options = {}) {
    this.namespace = options.namespace || 'aether';
    this.enableLogging = options.enableLogging || false;
    
    // Check availability
    this.available = this._checkAvailability();
    
    if (!this.available) {
      console.warn('[LocalStorage] localStorage not available, using in-memory fallback');
      this.fallback = new Map();
    }
  }

  /**
   * Set item
   * @param {string} key - Storage key
   * @param {*} value - Value to store (will be JSON stringified)
   * @returns {boolean} Success
   */
  set(key, value) {
    const fullKey = this._getFullKey(key);
    
    try {
      const serialized = JSON.stringify({
        value,
        timestamp: Date.now(),
        version: 1
      });
      
      if (this.available) {
        localStorage.setItem(fullKey, serialized);
      } else {
        this.fallback.set(fullKey, serialized);
      }
      
      if (this.enableLogging) {
        console.log(`[LocalStorage] Set ${fullKey}`);
      }
      
      return true;
    } catch (error) {
      console.error(`[LocalStorage] Failed to set ${fullKey}:`, error);
      
      // Handle quota exceeded
      if (error.name === 'QuotaExceededError') {
        console.warn('[LocalStorage] Quota exceeded, attempting cleanup');
        this._cleanup();
        
        // Retry once
        try {
          if (this.available) {
            localStorage.setItem(fullKey, serialized);
          } else {
            this.fallback.set(fullKey, serialized);
          }
          return true;
        } catch {
          return false;
        }
      }
      
      return false;
    }
  }

  /**
   * Get item
   * @param {string} key - Storage key
   * @param {*} defaultValue - Default value if not found
   * @returns {*} Retrieved value or default
   */
  get(key, defaultValue = null) {
    const fullKey = this._getFullKey(key);
    
    try {
      let serialized;
      
      if (this.available) {
        serialized = localStorage.getItem(fullKey);
      } else {
        serialized = this.fallback.get(fullKey);
      }
      
      if (!serialized) {
        return defaultValue;
      }
      
      const parsed = JSON.parse(serialized);
      
      if (this.enableLogging) {
        console.log(`[LocalStorage] Get ${fullKey}`);
      }
      
      return parsed.value;
    } catch (error) {
      console.error(`[LocalStorage] Failed to get ${fullKey}:`, error);
      return defaultValue;
    }
  }

  /**
   * Remove item
   * @param {string} key - Storage key
   * @returns {boolean} Success
   */
  remove(key) {
    const fullKey = this._getFullKey(key);
    
    try {
      if (this.available) {
        localStorage.removeItem(fullKey);
      } else {
        this.fallback.delete(fullKey);
      }
      
      if (this.enableLogging) {
        console.log(`[LocalStorage] Removed ${fullKey}`);
      }
      
      return true;
    } catch (error) {
      console.error(`[LocalStorage] Failed to remove ${fullKey}:`, error);
      return false;
    }
  }

  /**
   * Check if key exists
   * @param {string} key - Storage key
   * @returns {boolean}
   */
  has(key) {
    const fullKey = this._getFullKey(key);
    
    if (this.available) {
      return localStorage.getItem(fullKey) !== null;
    } else {
      return this.fallback.has(fullKey);
    }
  }

  /**
   * Clear all keys in namespace
   * @returns {number} Number of keys removed
   */
  clear() {
    let removed = 0;
    
    try {
      if (this.available) {
        const keys = Object.keys(localStorage);
        const prefix = `${this.namespace}:`;
        
        for (const key of keys) {
          if (key.startsWith(prefix)) {
            localStorage.removeItem(key);
            removed++;
          }
        }
      } else {
        const keys = Array.from(this.fallback.keys());
        const prefix = `${this.namespace}:`;
        
        for (const key of keys) {
          if (key.startsWith(prefix)) {
            this.fallback.delete(key);
            removed++;
          }
        }
      }
      
      if (this.enableLogging) {
        console.log(`[LocalStorage] Cleared ${removed} keys`);
      }
    } catch (error) {
      console.error('[LocalStorage] Failed to clear:', error);
    }
    
    return removed;
  }

  /**
   * List all keys in namespace
   * @returns {Array<string>} Keys without namespace prefix
   */
  keys() {
    const prefix = `${this.namespace}:`;
    const keys = [];
    
    try {
      if (this.available) {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(prefix)) {
            keys.push(key.substring(prefix.length));
          }
        }
      } else {
        for (const key of this.fallback.keys()) {
          if (key.startsWith(prefix)) {
            keys.push(key.substring(prefix.length));
          }
        }
      }
    } catch (error) {
      console.error('[LocalStorage] Failed to list keys:', error);
    }
    
    return keys;
  }

  /**
   * Get storage statistics
   * @returns {Object}
   */
  getStats() {
    const stats = {
      available: this.available,
      namespace: this.namespace,
      keyCount: 0,
      estimatedSize: 0,
      quota: null,
      usage: null
    };
    
    try {
      stats.keyCount = this.keys().length;
      
      if (this.available) {
        // Estimate size
        let totalSize = 0;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(`${this.namespace}:`)) {
            const value = localStorage.getItem(key);
            totalSize += key.length + (value ? value.length : 0);
          }
        }
        stats.estimatedSize = totalSize;
        
        // Storage quota (if available)
        if (navigator.storage && navigator.storage.estimate) {
          navigator.storage.estimate().then(estimate => {
            stats.quota = estimate.quota;
            stats.usage = estimate.usage;
          });
        }
      }
    } catch (error) {
      console.error('[LocalStorage] Failed to get stats:', error);
    }
    
    return freeze(stats);
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Get full namespaced key
   * @private
   */
  _getFullKey(key) {
    return `${this.namespace}:${key}`;
  }

  /**
   * Check localStorage availability
   * @private
   */
  _checkAvailability() {
    try {
      const test = '__storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cleanup old entries when quota exceeded
   * @private
   */
  _cleanup() {
    try {
      const prefix = `${this.namespace}:`;
      const items = [];
      
      // Collect all items with timestamps
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          try {
            const value = localStorage.getItem(key);
            const parsed = JSON.parse(value);
            items.push({
              key,
              timestamp: parsed.timestamp || 0
            });
          } catch {
            // Invalid JSON, mark for removal
            items.push({ key, timestamp: 0 });
          }
        }
      }
      
      // Sort by oldest first
      items.sort((a, b) => a.timestamp - b.timestamp);
      
      // Remove oldest 25%
      const removeCount = Math.ceil(items.length * 0.25);
      for (let i = 0; i < removeCount; i++) {
        localStorage.removeItem(items[i].key);
      }
      
      console.log(`[LocalStorage] Cleanup removed ${removeCount} old entries`);
    } catch (error) {
      console.error('[LocalStorage] Cleanup failed:', error);
    }
  }
}

// Export
module.exports = { LocalStorage };

if (typeof window !== 'undefined') {
  window.LocalStorage = LocalStorage;
  console.log('📦 LocalStorage loaded');
}

