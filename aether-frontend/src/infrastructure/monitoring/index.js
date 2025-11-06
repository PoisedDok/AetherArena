'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export MetricsCollector, PerformanceMonitor, ErrorTracker, PerformanceBudget, StartupProfiler, MemoryMonitor, RendererOptimizer, PerformanceIntegration for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: infrastructure/* (monitoring components) --- {module_exports, javascript_object}
 * 
 * 
 * @module infrastructure/monitoring/index
 * 
 * Monitoring Infrastructure - Metrics collection and error tracking
 * ============================================================================
 * Centralized exports for all monitoring components.
 * 
 * @module infrastructure/monitoring
 */

const { MetricsCollector } = require('./MetricsCollector');
const { PerformanceMonitor } = require('./PerformanceMonitor');
const { ErrorTracker } = require('./ErrorTracker');
const { PerformanceBudget, DEFAULT_BUDGETS } = require('./PerformanceBudget');
const { StartupProfiler, PHASES, MILESTONES } = require('./StartupProfiler');
const { MemoryMonitor, THRESHOLDS } = require('./MemoryMonitor');
const { RendererOptimizer } = require('./RendererOptimizer');
const { PerformanceIntegration } = require('./PerformanceIntegration');

module.exports = {
  // Core monitoring
  MetricsCollector,
  PerformanceMonitor,
  ErrorTracker,
  
  // Performance hardening (Phase 10)
  PerformanceBudget,
  StartupProfiler,
  MemoryMonitor,
  RendererOptimizer,
  PerformanceIntegration,
  
  // Constants
  DEFAULT_BUDGETS,
  PHASES,
  MILESTONES,
  THRESHOLDS,
};

