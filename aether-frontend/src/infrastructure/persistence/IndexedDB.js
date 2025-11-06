'use strict';

/**
 * @.architecture
 * 
 * Incoming: Repository layers (.put/.get/.delete/.clear/.queryByIndex calls) --- {method_calls, javascript_api}
 * Processing: Wrap IndexedDB API in Promise-based interface, manage object stores (define schema: keyPath/autoIncrement/indexes), execute CRUD operations (put/get/getAll/delete/clear), query by indexes, bulk operations, transaction support, version upgrades (onupgradeneeded), storage quota management, close connections --- {7 jobs: JOB_CLEAR_STATE, JOB_DISPOSE, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_SAVE_TO_DB, JOB_UPDATE_DB}
 * Outgoing: Return Promise<data> for all operations --- {database_types.*, any}
 * 
 * 
 * @module infrastructure/persistence/IndexedDB
 * 
 * IndexedDB - Structured client-side database wrapper
 * ============================================================================
 * Production-grade IndexedDB wrapper with:
 * - Promise-based API
 * - Transaction management
 * - Index support
 * - Bulk operations
 * - Version migration
 * 
 * Used for:
 * - Structured local data
 * - Offline cache
 * - Large datasets
 * - Binary data (files, images)
 */

const { freeze } = Object;

class IndexedDB {
  constructor(options = {}) {
    this.dbName = options.dbName || 'aether-db';
    this.version = options.version || 1;
    this.stores = options.stores || {};
    this.enableLogging = options.enableLogging || false;
    
    this.db = null;
    this.available = typeof indexedDB !== 'undefined';
    
    if (!this.available) {
      console.warn('[IndexedDB] IndexedDB not available');
    }
  }

  /**
   * Open database connection
   * @returns {Promise<void>}
   */
  async open() {
    if (!this.available) {
      throw new Error('IndexedDB not available');
    }

    if (this.db) {
      return; // Already open
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => {
        console.error('[IndexedDB] Failed to open database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        
        if (this.enableLogging) {
          console.log(`[IndexedDB] Opened database ${this.dbName} v${this.version}`);
        }
        
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (this.enableLogging) {
          console.log(`[IndexedDB] Upgrading database from v${event.oldVersion} to v${event.newVersion}`);
        }
        
        // Create object stores
        for (const [storeName, storeConfig] of Object.entries(this.stores)) {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, {
              keyPath: storeConfig.keyPath || 'id',
              autoIncrement: storeConfig.autoIncrement || false
            });
            
            // Create indexes
            if (storeConfig.indexes) {
              for (const [indexName, indexConfig] of Object.entries(storeConfig.indexes)) {
                store.createIndex(indexName, indexConfig.keyPath, {
                  unique: indexConfig.unique || false,
                  multiEntry: indexConfig.multiEntry || false
                });
              }
            }
            
            if (this.enableLogging) {
              console.log(`[IndexedDB] Created store: ${storeName}`);
            }
          }
        }
      };
    });
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      
      if (this.enableLogging) {
        console.log('[IndexedDB] Closed database');
      }
    }
  }

  /**
   * Put item (insert or update)
   * @param {string} storeName - Object store name
   * @param {*} value - Value to store
   * @returns {Promise<*>} Key of stored item
   */
  async put(storeName, value) {
    await this._ensureOpen();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(value);

      request.onsuccess = () => {
        if (this.enableLogging) {
          console.log(`[IndexedDB] Put item in ${storeName}`);
        }
        resolve(request.result);
      };

      request.onerror = () => {
        console.error(`[IndexedDB] Failed to put item in ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get item by key
   * @param {string} storeName - Object store name
   * @param {*} key - Item key
   * @returns {Promise<*>} Retrieved item or undefined
   */
  async get(storeName, key) {
    await this._ensureOpen();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => {
        if (this.enableLogging) {
          console.log(`[IndexedDB] Get item from ${storeName}:`, key);
        }
        resolve(request.result);
      };

      request.onerror = () => {
        console.error(`[IndexedDB] Failed to get item from ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get all items in store
   * @param {string} storeName - Object store name
   * @returns {Promise<Array>} All items
   */
  async getAll(storeName) {
    await this._ensureOpen();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        if (this.enableLogging) {
          console.log(`[IndexedDB] Get all from ${storeName}: ${request.result.length} items`);
        }
        resolve(request.result);
      };

      request.onerror = () => {
        console.error(`[IndexedDB] Failed to get all from ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Delete item by key
   * @param {string} storeName - Object store name
   * @param {*} key - Item key
   * @returns {Promise<void>}
   */
  async delete(storeName, key) {
    await this._ensureOpen();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onsuccess = () => {
        if (this.enableLogging) {
          console.log(`[IndexedDB] Deleted item from ${storeName}:`, key);
        }
        resolve();
      };

      request.onerror = () => {
        console.error(`[IndexedDB] Failed to delete item from ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Clear all items in store
   * @param {string} storeName - Object store name
   * @returns {Promise<void>}
   */
  async clear(storeName) {
    await this._ensureOpen();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onsuccess = () => {
        if (this.enableLogging) {
          console.log(`[IndexedDB] Cleared store ${storeName}`);
        }
        resolve();
      };

      request.onerror = () => {
        console.error(`[IndexedDB] Failed to clear store ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Count items in store
   * @param {string} storeName - Object store name
   * @returns {Promise<number>} Item count
   */
  async count(storeName) {
    await this._ensureOpen();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.count();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        console.error(`[IndexedDB] Failed to count items in ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Query items using index
   * @param {string} storeName - Object store name
   * @param {string} indexName - Index name
   * @param {*} query - Query value or IDBKeyRange
   * @returns {Promise<Array>} Matching items
   */
  async queryByIndex(storeName, indexName, query) {
    await this._ensureOpen();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(query);

      request.onsuccess = () => {
        if (this.enableLogging) {
          console.log(`[IndexedDB] Query ${storeName} by ${indexName}: ${request.result.length} results`);
        }
        resolve(request.result);
      };

      request.onerror = () => {
        console.error(`[IndexedDB] Failed to query ${storeName}:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Bulk put operation
   * @param {string} storeName - Object store name
   * @param {Array} items - Items to store
   * @returns {Promise<void>}
   */
  async bulkPut(storeName, items) {
    await this._ensureOpen();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      
      let completed = 0;
      const total = items.length;
      
      transaction.oncomplete = () => {
        if (this.enableLogging) {
          console.log(`[IndexedDB] Bulk put ${total} items in ${storeName}`);
        }
        resolve();
      };
      
      transaction.onerror = () => {
        console.error(`[IndexedDB] Bulk put failed in ${storeName}:`, transaction.error);
        reject(transaction.error);
      };
      
      for (const item of items) {
        store.put(item);
      }
    });
  }

  /**
   * Get database statistics
   * @returns {Promise<Object>}
   */
  async getStats() {
    await this._ensureOpen();
    
    const stats = {
      dbName: this.dbName,
      version: this.version,
      stores: {}
    };
    
    try {
      for (const storeName of this.db.objectStoreNames) {
        const count = await this.count(storeName);
        stats.stores[storeName] = { count };
      }
      
      // Storage quota
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        stats.quota = estimate.quota;
        stats.usage = estimate.usage;
      }
    } catch (error) {
      console.error('[IndexedDB] Failed to get stats:', error);
    }
    
    return freeze(stats);
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Ensure database is open
   * @private
   */
  async _ensureOpen() {
    if (!this.db) {
      await this.open();
    }
  }
}

// Export
module.exports = { IndexedDB };

if (typeof window !== 'undefined') {
  window.IndexedDB = IndexedDB;
  console.log('📦 IndexedDB loaded');
}

