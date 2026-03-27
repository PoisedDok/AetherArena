'use strict';

/**
 * @module infrastructure/index
 * 
 * Infrastructure Layer
 * ============================================================================
 * External integrations, persistence, monitoring, and IPC infrastructure.
 * 
 * Architecture:
 * - API: Supabase client and backend service clients
 * - Persistence: Simple key-value storage (LocalStorage only - Supabase for database)
 * - Monitoring: Metrics collection, performance tracking, error reporting
 * - IPC: Inter-process communication (Electron)
 * 
 * NOTE: Database persistence is now exclusively via Supabase.
 * IndexedDB and SQLiteAdapter have been removed.
 * 
 * Re-exports: StorageAPI, LocalStorage, MetricsCollector, PerformanceMonitor, 
 * ErrorTracker, IpcBridge for centralized import path.
 */

const api = require('./api');
const persistence = require('./persistence');
const monitoring = require('./monitoring');
const ipc = require('./ipc');

module.exports = {
  // API clients (Supabase is the primary database client)
  StorageAPI: api.StorageAPI,
  
  // Persistence (legacy LocalStorage only - use Supabase for database operations)
  LocalStorage: persistence.LocalStorage,
  // IndexedDB - REMOVED: Use Supabase
  // SQLiteAdapter - REMOVED: Use Supabase
  
  // Monitoring
  MetricsCollector: monitoring.MetricsCollector,
  PerformanceMonitor: monitoring.PerformanceMonitor,
  ErrorTracker: monitoring.ErrorTracker,
  
  // IPC
  IpcBridge: ipc.IpcBridge
};
