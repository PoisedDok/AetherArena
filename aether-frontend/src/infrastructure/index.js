'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export StorageAPI (api), LocalStorage/IndexedDB/SQLiteAdapter (persistence), MetricsCollector/PerformanceMonitor/ErrorTracker (monitoring), IpcBridge (ipc) for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: All modules (infrastructure layer) --- {module_exports, javascript_object}
 * 
 * 
 * @module infrastructure/index
 * 
 * Infrastructure Layer
 * ============================================================================
 * External integrations, persistence, monitoring, and IPC infrastructure.
 * 
 * Architecture:
 * - API: External service clients (aether-backend only)
 * - Persistence: Client-side storage (localStorage, IndexedDB, SQLite)
 * - Monitoring: Metrics collection, performance tracking, error reporting
 * - IPC: Inter-process communication (Electron)
 * 
 * @module infrastructure
 */

const api = require('./api');
const persistence = require('./persistence');
const monitoring = require('./monitoring');
const ipc = require('./ipc');

module.exports = {
  // API clients
  StorageAPI: api.StorageAPI,
  
  // Persistence
  LocalStorage: persistence.LocalStorage,
  IndexedDB: persistence.IndexedDB,
  SQLiteAdapter: persistence.SQLiteAdapter,
  
  // Monitoring
  MetricsCollector: monitoring.MetricsCollector,
  PerformanceMonitor: monitoring.PerformanceMonitor,
  ErrorTracker: monitoring.ErrorTracker,
  
  // IPC
  IpcBridge: ipc.IpcBridge
};

