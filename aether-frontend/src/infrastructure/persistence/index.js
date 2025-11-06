'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export LocalStorage, IndexedDB, SQLiteAdapter for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: infrastructure/* (persistence adapters) --- {module_exports, javascript_object}
 * 
 * 
 * @module infrastructure/persistence/index
 * 
 * Persistence Infrastructure - Client-side storage
 * ============================================================================
 * Centralized exports for all persistence adapters.
 * 
 * @module infrastructure/persistence
 */

const { LocalStorage } = require('./LocalStorage');
const { IndexedDB } = require('./IndexedDB');
const { SQLiteAdapter } = require('./SQLiteAdapter');

module.exports = {
  LocalStorage,
  IndexedDB,
  SQLiteAdapter
};

