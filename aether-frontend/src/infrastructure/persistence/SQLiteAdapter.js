'use strict';

/**
 * @.architecture
 * 
 * Incoming: Main process storage/cache modules (.query/.get/.run/.transaction calls) --- {method_calls, javascript_api}
 * Processing: Wrap better-sqlite3 with Promise-compatible API, lazy-load better-sqlite3 module, open database at dbPath (from config.paths.sqliteDb), enable WAL mode (journal_mode = WAL), initialize schema (cache/sessions/metadata tables), execute queries (all/get/run), transaction support, backup/vacuum, getStats (page count/size/tables) --- {9 jobs: JOB_INITIALIZE, JOB_INITIALIZE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_UPDATE_DB, JOB_WRITE_FILE, JOB_DISPOSE, JOB_GET_STATE, JOB_GET_STATE}
 * Outgoing: Return Promise<data> for queries, info object for run {changes, lastInsertRowid} --- {database_types.*, any}
 * 
 * 
 * @module infrastructure/persistence/SQLiteAdapter
 * 
 * SQLiteAdapter - Main process SQLite database wrapper
 * ============================================================================
 * Production-grade SQLite adapter for Electron main process:
 * - Local cache and persistence
 * - Session management
 * - Offline storage
 * - Transaction support
 * 
 * Note: This adapter is for main process only.
 * Renderer processes should use IndexedDB or communicate via IPC.
 */

const { freeze } = Object;

class SQLiteAdapter {
  constructor(options = {}) {
    // Import config dynamically to avoid circular dependencies
    const config = require('../../core/config');
    this.dbPath = options.dbPath || config.paths.sqliteDb;
    this.enableLogging = options.enableLogging || false;
    
    this.db = null;
    this.sqlite3 = null;
    
    // Check if running in main process
    this.isMainProcess = typeof process !== 'undefined' && process.type === 'browser';
    
    if (!this.isMainProcess) {
      console.warn('[SQLiteAdapter] Should only be used in Electron main process');
    }
  }

  /**
   * Open database connection
   * @returns {Promise<void>}
   */
  async open() {
    if (this.db) {
      return; // Already open
    }

    if (!this.isMainProcess) {
      throw new Error('SQLiteAdapter requires Electron main process');
    }

    try {
      // Lazy load better-sqlite3
      this.sqlite3 = require('better-sqlite3');
      
      this.db = new this.sqlite3(this.dbPath, {
        verbose: this.enableLogging ? console.log : null
      });
      
      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');
      
      if (this.enableLogging) {
        console.log(`[SQLiteAdapter] Opened database: ${this.dbPath}`);
      }
      
      // Initialize schema if needed
      await this._initializeSchema();
    } catch (error) {
      console.error('[SQLiteAdapter] Failed to open database:', error);
      throw error;
    }
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      
      if (this.enableLogging) {
        console.log('[SQLiteAdapter] Closed database');
      }
    }
  }

  /**
   * Execute query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Object>} Query result
   */
  async query(sql, params = []) {
    await this._ensureOpen();
    
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.all(...params);
      
      if (this.enableLogging) {
        console.log(`[SQLiteAdapter] Query executed: ${sql.substring(0, 50)}...`);
      }
      
      return result;
    } catch (error) {
      console.error('[SQLiteAdapter] Query failed:', error);
      throw error;
    }
  }

  /**
   * Execute single row query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Object|null>} First row or null
   */
  async get(sql, params = []) {
    await this._ensureOpen();
    
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.get(...params);
      
      return result || null;
    } catch (error) {
      console.error('[SQLiteAdapter] Get failed:', error);
      throw error;
    }
  }

  /**
   * Execute insert/update/delete
   * @param {string} sql - SQL statement
   * @param {Array} params - Statement parameters
   * @returns {Promise<Object>} Info object with changes and lastInsertRowid
   */
  async run(sql, params = []) {
    await this._ensureOpen();
    
    try {
      const stmt = this.db.prepare(sql);
      const info = stmt.run(...params);
      
      if (this.enableLogging) {
        console.log(`[SQLiteAdapter] Run: ${info.changes} rows affected`);
      }
      
      return freeze({
        changes: info.changes,
        lastInsertRowid: info.lastInsertRowid
      });
    } catch (error) {
      console.error('[SQLiteAdapter] Run failed:', error);
      throw error;
    }
  }

  /**
   * Execute transaction
   * @param {Function} fn - Transaction function
   * @returns {Promise<*>} Transaction result
   */
  async transaction(fn) {
    await this._ensureOpen();
    
    try {
      const txn = this.db.transaction(fn);
      const result = txn();
      
      if (this.enableLogging) {
        console.log('[SQLiteAdapter] Transaction completed');
      }
      
      return result;
    } catch (error) {
      console.error('[SQLiteAdapter] Transaction failed:', error);
      throw error;
    }
  }

  /**
   * Execute multiple statements
   * @param {string} sql - Multiple SQL statements
   * @returns {Promise<void>}
   */
  async exec(sql) {
    await this._ensureOpen();
    
    try {
      this.db.exec(sql);
      
      if (this.enableLogging) {
        console.log('[SQLiteAdapter] Exec completed');
      }
    } catch (error) {
      console.error('[SQLiteAdapter] Exec failed:', error);
      throw error;
    }
  }

  /**
   * Get database statistics
   * @returns {Promise<Object>}
   */
  async getStats() {
    await this._ensureOpen();
    
    const stats = {
      dbPath: this.dbPath,
      inTransaction: this.db.inTransaction
    };
    
    try {
      // Get page count and size
      const pageCount = this.db.pragma('page_count', { simple: true });
      const pageSize = this.db.pragma('page_size', { simple: true });
      
      stats.pageCount = pageCount;
      stats.pageSize = pageSize;
      stats.size = pageCount * pageSize;
      
      // Get table list
      const tables = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all();
      
      stats.tables = tables.map(t => t.name);
    } catch (error) {
      console.error('[SQLiteAdapter] Failed to get stats:', error);
    }
    
    return freeze(stats);
  }

  /**
   * Vacuum database
   * @returns {Promise<void>}
   */
  async vacuum() {
    await this._ensureOpen();
    
    try {
      this.db.exec('VACUUM');
      
      if (this.enableLogging) {
        console.log('[SQLiteAdapter] Database vacuumed');
      }
    } catch (error) {
      console.error('[SQLiteAdapter] Vacuum failed:', error);
      throw error;
    }
  }

  /**
   * Backup database
   * @param {string} destPath - Destination file path
   * @returns {Promise<void>}
   */
  async backup(destPath) {
    await this._ensureOpen();
    
    try {
      await this.db.backup(destPath);
      
      if (this.enableLogging) {
        console.log(`[SQLiteAdapter] Backup created: ${destPath}`);
      }
    } catch (error) {
      console.error('[SQLiteAdapter] Backup failed:', error);
      throw error;
    }
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

  /**
   * Initialize database schema
   * @private
   */
  async _initializeSchema() {
    const schema = `
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        expires INTEGER
      );
      
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires);
      
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `;
    
    try {
      this.db.exec(schema);
      
      if (this.enableLogging) {
        console.log('[SQLiteAdapter] Schema initialized');
      }
    } catch (error) {
      console.error('[SQLiteAdapter] Schema initialization failed:', error);
      throw error;
    }
  }
}

// Export
module.exports = { SQLiteAdapter };

// Note: No window exposure - this is main process only
if (typeof process !== 'undefined' && process.type === 'browser') {
  console.log('📦 SQLiteAdapter loaded (main process)');
}

