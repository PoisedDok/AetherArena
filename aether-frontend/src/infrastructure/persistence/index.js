'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export LocalStorage module for simple key-value persistence (legacy compatibility only) --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: All modules requiring persistence --- {module_exports, javascript_object}
 * 
 * 
 * @module infrastructure/persistence/index
 * 
 * Persistence Layer (Legacy Compatibility)
 * ============================================================================
 * NOTE: Database persistence is now handled exclusively via Supabase.
 * This module only exports LocalStorage for simple key-value caching.
 * 
 * REMOVED:
 * - IndexedDB: Replaced by Supabase (all structured data)
 * - SQLiteAdapter: Replaced by Supabase (all database operations)
 * 
 * Architecture:
 * - LocalStorage: Simple key-value persistence (renderer) - legacy only
 * - Supabase: All database operations (via infrastructure/api/storage.js)
 * 
 * @module infrastructure/persistence
 */

const { LocalStorage } = require('./LocalStorage');

module.exports = {
  LocalStorage
  // IndexedDB - REMOVED: Use Supabase client
  // SQLiteAdapter - REMOVED: Use Supabase client
};

// Module loaded: persistence layer (LocalStorage only - Supabase for database operations)
