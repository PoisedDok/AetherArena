'use strict';

/**
 * @.architecture
 * 
 * Incoming: Constructor options (enableLogging/config with budgets/intervals/flags), direct method calls (start/stop/startPhase/endPhase/markMilestone/completeStartup/measure/measureAsync/validateBudgets/getReport/exportJSON/logStatus), callbacks from submodules (onBudgetExceeded/onLeakDetected/onViolation/onWarning) --- {method_calls, object | function}
 * Processing: Initialize monitoring components (StartupProfiler, MemoryMonitor, PerformanceBudget, RendererOptimizer, MetricsCollector, PerformanceMonitor), configure budgets (startup=2s, memory=400MB, fps=30, latency=300ms, lighthouse scores), start/stop monitoring, delegate startup tracking to StartupProfiler (startPhase/endPhase/markMilestone/completeStartup), validate startup budget (total/preload/domReady/bootstrap/moduleLoad/firstPaint/firstContentfulPaint/interactive), validate memory budget, validate runtime budget (fps/latency), delegate performance measurement to PerformanceMonitor (measure/measureAsync), handle callbacks (memory budget exceeded, leak detected, budget violation, budget warning), force GC on memory budget exceeded, generate comprehensive report (startup/memory/budgets/metrics/performance/optimization), export to JSON, log status --- {8 jobs: JOB_DELEGATE_TO_MODULE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_START, JOB_STOP, JOB_STRINGIFY_JSON, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return values (duration/validation results/report/JSON), callback handlers (console logs/warns/errors), window.__PERFORMANCE__ singleton, window.PerformanceIntegration global --- {number | object | string | class_reference, javascript_object | global}
 * 
 * 
 * @module infrastructure/monitoring/PerformanceIntegration
 * 
 * PerformanceIntegration - Integrated Performance Monitoring
 * ============================================================================
 * Unified performance monitoring integration combining:
 * - Startup profiling
 * - Memory monitoring
 * - Performance budgets
 * - Renderer optimization
 * - Metrics collection
 */

const { PerformanceBudget } = require('./PerformanceBudget');
const { StartupProfiler, PHASES, MILESTONES } = require('./StartupProfiler');
const { MemoryMonitor } = require('./MemoryMonitor');
const { RendererOptimizer } = require('./RendererOptimizer');
const { MetricsCollector } = require('./MetricsCollector');
const { PerformanceMonitor } = require('./PerformanceMonitor');

const { freeze } = Object;

class PerformanceIntegration {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging !== false;
    this.config = options.config || {};
    
    // Initialize monitoring components
    this.startupProfiler = new StartupProfiler({
      enableLogging: this.enableLogging,
      budget: this.config.startupBudget || 2000,
    });

    this.memoryMonitor = new MemoryMonitor({
      enableLogging: this.enableLogging,
      budget: this.config.memoryBudget || 400 * 1024 * 1024,
      sampleInterval: this.config.memoryInterval || 5000,
      onBudgetExceeded: (memory) => this._handleMemoryBudgetExceeded(memory),
      onLeakDetected: (leak) => this._handleLeakDetected(leak),
    });

    this.performanceBudget = new PerformanceBudget({
      enableLogging: this.enableLogging,
      budgets: {
        startup: {
          total: this.config.startupBudget || 2000,
        },
        memory: {
          heap: this.config.memoryBudget || 400 * 1024 * 1024,
        },
        runtime: {
          fps: this.config.fpsBudget || 30,
          latency: this.config.latencyBudget || 300,
        },
        lighthouse: {
          performance: this.config.lighthousePerformance || 90,
          accessibility: this.config.lighthouseAccessibility || 90,
          bestPractices: this.config.lighthouseBestPractices || 90,
          seo: this.config.lighthouseSEO || 80,
        },
      },
      onViolation: (violation) => this._handleBudgetViolation(violation),
      onWarning: (warning) => this._handleBudgetWarning(warning),
    });

    this.rendererOptimizer = new RendererOptimizer({
      enableLogging: this.enableLogging,
      autoOptimize: this.config.enableRendererOptimization !== false,
      performanceTarget: this.config.lighthousePerformance || 90,
      accessibilityTarget: this.config.lighthouseAccessibility || 90,
      bestPracticesTarget: this.config.lighthouseBestPractices || 90,
      seoTarget: this.config.lighthouseSEO || 80,
    });

    this.metricsCollector = new MetricsCollector({
      enableLogging: false, // Less verbose
      reportInterval: this.config.metricsInterval || 30000,
      reportToBackend: false, // Can enable to send to backend
    });

    this.performanceMonitor = new PerformanceMonitor({
      enableLogging: false, // Less verbose
      thresholds: {
        slow: 100,
        critical: 1000,
      },
    });

    // Global reference for easy access
    if (typeof window !== 'undefined') {
      window.__PERFORMANCE__ = this;
    }

    if (this.enableLogging) {
      console.log('[PerformanceIntegration] Initialized');
    }
  }

  // ==========================================================================
  // Lifecycle Management
  // ==========================================================================

  /**
   * Start all monitoring
   */
  start() {
    // Start memory monitoring
    if (this.config.enableMemoryMonitoring !== false) {
      this.memoryMonitor.start();
    }

    // Start metrics collection
    if (this.config.enableMonitoring !== false) {
      this.metricsCollector.start();
    }

    // Apply renderer optimizations
    if (this.config.enableRendererOptimization !== false) {
      this.rendererOptimizer._applyOptimizations();
    }

    if (this.enableLogging) {
      console.log('[PerformanceIntegration] Started monitoring');
    }
  }

  /**
   * Stop all monitoring
   */
  stop() {
    this.memoryMonitor.stop();
    this.metricsCollector.stop();

    if (this.enableLogging) {
      console.log('[PerformanceIntegration] Stopped monitoring');
    }
  }

  // ==========================================================================
  // Startup Tracking
  // ==========================================================================

  /**
   * Mark startup phase start
   * @param {string} phase - Phase name
   */
  startPhase(phase) {
    this.startupProfiler.startPhase(phase);
  }

  /**
   * Mark startup phase end
   * @param {string} phase - Phase name
   */
  endPhase(phase) {
    return this.startupProfiler.endPhase(phase);
  }

  /**
   * Mark startup milestone
   * @param {string} milestone - Milestone name
   */
  markMilestone(milestone) {
    this.startupProfiler.markMilestone(milestone);
  }

  /**
   * Complete startup tracking and validate budgets
   */
  async completeStartup() {
    // Mark complete
    this.startupProfiler.markMilestone(MILESTONES.COMPLETE);
    this.startupProfiler.completeStartup();

    // Get startup metrics
    const metrics = this.startupProfiler.getMetrics();

    // Validate startup budget
    const startupValidation = this.performanceBudget.validateStartup({
      total: metrics.total,
      preload: metrics.phases.find(p => p.name === PHASES.PRELOAD)?.duration,
      domReady: metrics.navigation?.domContentLoaded,
      bootstrap: metrics.phases.find(p => p.name === PHASES.BOOTSTRAP)?.duration,
      moduleLoad: metrics.phases.find(p => p.name === PHASES.MODULE_LOAD)?.duration,
      firstPaint: metrics.paint?.firstPaint,
      firstContentfulPaint: metrics.paint?.firstContentfulPaint,
      interactive: metrics.navigation?.domInteractive,
    });

    // Validate memory budget
    const memory = this.memoryMonitor.getCurrentMemory();
    if (memory) {
      this.performanceBudget.validateMemory(memory);
    }

    // Log results if enabled
    if (this.enableLogging) {
      this.startupProfiler.logSummary();
      
      if (!startupValidation.passed) {
        console.warn('[PerformanceIntegration] Startup budget violations detected');
      } else {
        console.log('[PerformanceIntegration] ✅ All startup budgets passed');
      }
    }

    return {
      startup: startupValidation,
      metrics,
      memory,
    };
  }

  // ==========================================================================
  // Performance Measurement
  // ==========================================================================

  /**
   * Measure operation performance
   * @param {string} name - Operation name
   * @param {Function} fn - Function to measure
   * @returns {*} Function result
   */
  measure(name, fn) {
    return this.performanceMonitor.measure(name, fn);
  }

  /**
   * Measure async operation performance
   * @param {string} name - Operation name
   * @param {Function} fn - Async function to measure
   * @returns {Promise<*>} Function result
   */
  async measureAsync(name, fn) {
    return await this.performanceMonitor.measureAsync(name, fn);
  }

  // ==========================================================================
  // Budget Validation
  // ==========================================================================

  /**
   * Validate current performance against budgets
   * @returns {Object} Validation results
   */
  validateBudgets() {
    const results = {};

    // Memory
    const memory = this.memoryMonitor.getCurrentMemory();
    if (memory) {
      results.memory = this.performanceBudget.validateMemory(memory);
    }

    // Runtime
    const fpsStats = this.metricsCollector.getFPSStats();
    const latencyStats = this.metricsCollector.getLatencyStats();
    
    results.runtime = this.performanceBudget.validateRuntime({
      fps: fpsStats.current,
      latency: latencyStats.current,
    });

    return freeze(results);
  }

  // ==========================================================================
  // Reporting
  // ==========================================================================

  /**
   * Get comprehensive performance report
   * @returns {Object}
   */
  getReport() {
    return freeze({
      timestamp: Date.now(),
      startup: this.startupProfiler.getMetrics(),
      memory: this.memoryMonitor.getReport(),
      budgets: this.performanceBudget.getStatus(),
      metrics: {
        fps: this.metricsCollector.getFPSStats(),
        latency: this.metricsCollector.getLatencyStats(),
        memory: this.metricsCollector.getMemoryStats(),
        requests: this.metricsCollector.getRequestStats(),
      },
      performance: {
        summary: this.performanceMonitor.getSummary(),
        renderTiming: this.performanceMonitor.getRenderTiming(),
        resourceTiming: this.performanceMonitor.getResourceTiming(),
      },
      optimization: this.rendererOptimizer.getReport(),
    });
  }

  /**
   * Export report as JSON
   * @returns {string}
   */
  exportJSON() {
    return JSON.stringify(this.getReport(), null, 2);
  }

  /**
   * Log performance status
   */
  logStatus() {
    console.group('[PerformanceIntegration] Performance Status');
    
    // Startup
    console.log('Startup:', this.startupProfiler.getSummary());
    
    // Memory
    this.memoryMonitor.logStatus();
    
    // Budgets
    const budgetStatus = this.performanceBudget.getStatus();
    console.log('Budget Status:', budgetStatus.overall);
    console.log('Violations:', budgetStatus.violations);
    console.log('Warnings:', budgetStatus.warnings);
    
    // Performance
    const perfSummary = this.performanceMonitor.getSummary();
    console.log('Performance Summary:', perfSummary);
    
    console.groupEnd();
  }

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  /**
   * Handle memory budget exceeded
   * @private
   */
  _handleMemoryBudgetExceeded(memory) {
    console.error('[PerformanceIntegration] ❌ MEMORY BUDGET EXCEEDED:', memory);
    
    // Attempt garbage collection if available
    this.memoryMonitor.forceGC();
    
    // Log detailed memory report
    this.memoryMonitor.logStatus();
  }

  /**
   * Handle memory leak detected
   * @private
   */
  _handleLeakDetected(leak) {
    console.warn('[PerformanceIntegration] ⚠️  POTENTIAL MEMORY LEAK DETECTED:', leak);
  }

  /**
   * Handle budget violation
   * @private
   */
  _handleBudgetViolation(violation) {
    console.warn('[PerformanceIntegration] ⚠️  BUDGET VIOLATION:', violation);
  }

  /**
   * Handle budget warning
   * @private
   */
  _handleBudgetWarning(warning) {
    if (this.enableLogging) {
      console.warn('[PerformanceIntegration] ⚠️  BUDGET WARNING:', warning);
    }
  }
}

// Export
module.exports = { PerformanceIntegration, PHASES, MILESTONES };

if (typeof window !== 'undefined') {
  window.PerformanceIntegration = PerformanceIntegration;
  console.log('📦 PerformanceIntegration loaded');
}

