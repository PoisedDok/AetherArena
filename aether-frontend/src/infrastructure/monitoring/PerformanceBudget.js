'use strict';

/**
 * @.architecture
 * 
 * Incoming: Constructor options (enableLogging/budgets/onViolation/onWarning), direct method calls (validateStartup/validateMemory/validateRuntime/validateResources/getStatus/getReport/exportJSON/clear), metrics objects --- {method_calls, object | function}
 * Processing: Initialize DEFAULT_BUDGETS (startup/memory/runtime/resources/lighthouse), merge custom budgets with defaults, track violations array, warnings array, state (startup/memory/runtime/resources/lighthouse), validate startup metrics (total/preload/domReady/bootstrap/moduleLoad/firstPaint/firstContentfulPaint/interactive), validate memory (heap/warning/critical), validate runtime (fps/latency), validate resources (scripts/styles/images/fonts/totalTransferSize), record violations (actual/budget/overage), record warnings (90% threshold), trigger callbacks (onViolation/onWarning), generate recommendations, get status/report, export to JSON, clear violations/warnings --- {10 jobs: JOB_GET_STATE, JOB_CLEAR_STATE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_STRINGIFY_JSON, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return validation results (passed/violations/warnings), callbacks (onViolation/onWarning), console.warn for violations/warnings, return status/report/JSON, window.PerformanceBudget global --- {object | string | class_reference, javascript_object | global}
 * 
 * 
 * @module infrastructure/monitoring/PerformanceBudget
 * 
 * PerformanceBudget - Performance Budget Management
 * ============================================================================
 * Production-grade performance budget enforcement:
 * - Startup time < 2s
 * - Memory < 400MB steady-state
 * - FPS > 30
 * - Operation timing budgets
 * - Automatic alerts on budget violations
 * - Detailed budget reports
 */

const { freeze } = Object;

/**
 * Default Performance Budgets
 */
const DEFAULT_BUDGETS = freeze({
  // Startup budgets (milliseconds)
  startup: freeze({
    total: 2000,              // Total startup < 2s
    preload: 200,             // Preload script < 200ms
    domReady: 500,            // DOM ready < 500ms
    bootstrap: 800,           // Bootstrap < 800ms
    moduleLoad: 600,          // Module loading < 600ms
    firstPaint: 1000,         // First paint < 1s
    firstContentfulPaint: 1500, // FCP < 1.5s
    interactive: 2000,        // TTI < 2s
  }),

  // Memory budgets (bytes)
  memory: freeze({
    heap: 400 * 1024 * 1024,  // 400MB heap limit
    warning: 350 * 1024 * 1024, // 350MB warning threshold
    critical: 380 * 1024 * 1024, // 380MB critical threshold
    leakThreshold: 10 * 1024 * 1024, // 10MB leak detection
    growthRate: 5 * 1024 * 1024,     // 5MB/min growth rate
  }),

  // Runtime budgets
  runtime: freeze({
    fps: 30,                  // Minimum FPS
    fpsTarget: 60,            // Target FPS
    operationSlow: 100,       // Slow operation > 100ms
    operationCritical: 1000,  // Critical operation > 1s
    latency: 300,             // Network latency < 300ms
    renderFrame: 16,          // Frame render < 16ms (60fps)
  }),

  // Resource budgets
  resources: freeze({
    maxScripts: 50,           // Max script resources
    maxStyles: 20,            // Max stylesheet resources
    maxImages: 100,           // Max image resources
    maxFonts: 10,             // Max font resources
    totalTransferSize: 10 * 1024 * 1024, // 10MB total transfer
  }),

  // Lighthouse targets
  lighthouse: freeze({
    performance: 90,          // Performance score > 90
    accessibility: 90,        // Accessibility score > 90
    bestPractices: 90,        // Best practices > 90
    seo: 80,                  // SEO > 80
    pwa: 0,                   // PWA not applicable for desktop
  }),
});

class PerformanceBudget {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging !== false;
    this.budgets = this._mergeBudgets(DEFAULT_BUDGETS, options.budgets || {});
    
    // Violation tracking
    this.violations = [];
    this.warnings = [];
    this.startTime = Date.now();
    
    // Budget state
    this.state = {
      startup: { passed: false, violations: [] },
      memory: { passed: true, violations: [] },
      runtime: { passed: true, violations: [] },
      resources: { passed: true, violations: [] },
      lighthouse: { passed: false, violations: [] },
    };

    // Callbacks
    this.onViolation = options.onViolation || null;
    this.onWarning = options.onWarning || null;

    if (this.enableLogging) {
      console.log('[PerformanceBudget] Initialized with budgets:', this.budgets);
    }
  }

  // ==========================================================================
  // Budget Validation
  // ==========================================================================

  /**
   * Validate startup performance
   * @param {Object} metrics - Startup metrics
   * @returns {Object} Validation result
   */
  validateStartup(metrics) {
    const violations = [];
    const warnings = [];

    const budgets = this.budgets.startup;

    // Check each startup metric
    const checks = [
      { name: 'total', value: metrics.total, budget: budgets.total },
      { name: 'preload', value: metrics.preload, budget: budgets.preload },
      { name: 'domReady', value: metrics.domReady, budget: budgets.domReady },
      { name: 'bootstrap', value: metrics.bootstrap, budget: budgets.bootstrap },
      { name: 'moduleLoad', value: metrics.moduleLoad, budget: budgets.moduleLoad },
      { name: 'firstPaint', value: metrics.firstPaint, budget: budgets.firstPaint },
      { name: 'firstContentfulPaint', value: metrics.firstContentfulPaint, budget: budgets.firstContentfulPaint },
      { name: 'interactive', value: metrics.interactive, budget: budgets.interactive },
    ];

    for (const check of checks) {
      if (check.value === null || check.value === undefined) continue;

      if (check.value > check.budget) {
        const violation = {
          category: 'startup',
          metric: check.name,
          actual: check.value,
          budget: check.budget,
          overage: check.value - check.budget,
          timestamp: Date.now(),
        };

        violations.push(violation);
        this._recordViolation(violation);
      } else if (check.value > check.budget * 0.9) {
        // Warning if within 10% of budget
        const warning = {
          category: 'startup',
          metric: check.name,
          actual: check.value,
          budget: check.budget,
          percentage: (check.value / check.budget) * 100,
          timestamp: Date.now(),
        };

        warnings.push(warning);
        this._recordWarning(warning);
      }
    }

    const passed = violations.length === 0;
    this.state.startup = { passed, violations, warnings };

    if (this.enableLogging) {
      if (passed) {
        console.log('[PerformanceBudget] ✅ Startup budget passed');
      } else {
        console.warn('[PerformanceBudget] ❌ Startup budget violations:', violations);
      }
    }

    return { passed, violations, warnings };
  }

  /**
   * Validate memory usage
   * @param {Object} metrics - Memory metrics
   * @returns {Object} Validation result
   */
  validateMemory(metrics) {
    const violations = [];
    const warnings = [];

    const budgets = this.budgets.memory;
    const usedHeap = metrics.usedJSHeapSize || metrics.used || 0;

    // Check heap limit
    if (usedHeap > budgets.heap) {
      const violation = {
        category: 'memory',
        metric: 'heap',
        actual: usedHeap,
        budget: budgets.heap,
        overage: usedHeap - budgets.heap,
        timestamp: Date.now(),
      };

      violations.push(violation);
      this._recordViolation(violation);
    } else if (usedHeap > budgets.critical) {
      // Critical warning
      const warning = {
        category: 'memory',
        metric: 'heap',
        level: 'critical',
        actual: usedHeap,
        budget: budgets.heap,
        percentage: (usedHeap / budgets.heap) * 100,
        timestamp: Date.now(),
      };

      warnings.push(warning);
      this._recordWarning(warning);
    } else if (usedHeap > budgets.warning) {
      // Standard warning
      const warning = {
        category: 'memory',
        metric: 'heap',
        level: 'warning',
        actual: usedHeap,
        budget: budgets.heap,
        percentage: (usedHeap / budgets.heap) * 100,
        timestamp: Date.now(),
      };

      warnings.push(warning);
      this._recordWarning(warning);
    }

    const passed = violations.length === 0;
    this.state.memory = { passed, violations, warnings };

    if (!passed && this.enableLogging) {
      console.warn('[PerformanceBudget] ❌ Memory budget violations:', violations);
    }

    return { passed, violations, warnings };
  }

  /**
   * Validate runtime performance
   * @param {Object} metrics - Runtime metrics
   * @returns {Object} Validation result
   */
  validateRuntime(metrics) {
    const violations = [];
    const warnings = [];

    const budgets = this.budgets.runtime;

    // Check FPS
    if (metrics.fps !== undefined && metrics.fps < budgets.fps) {
      violations.push({
        category: 'runtime',
        metric: 'fps',
        actual: metrics.fps,
        budget: budgets.fps,
        underrun: budgets.fps - metrics.fps,
        timestamp: Date.now(),
      });
    }

    // Check latency
    if (metrics.latency !== undefined && metrics.latency > budgets.latency) {
      violations.push({
        category: 'runtime',
        metric: 'latency',
        actual: metrics.latency,
        budget: budgets.latency,
        overage: metrics.latency - budgets.latency,
        timestamp: Date.now(),
      });
    }

    const passed = violations.length === 0;
    this.state.runtime = { passed, violations, warnings };

    return { passed, violations, warnings };
  }

  /**
   * Validate resource usage
   * @param {Object} resources - Resource metrics
   * @returns {Object} Validation result
   */
  validateResources(resources) {
    const violations = [];
    const warnings = [];

    const budgets = this.budgets.resources;

    // Resource counts
    const counts = {
      scripts: resources.scripts?.length || 0,
      styles: resources.styles?.length || 0,
      images: resources.images?.length || 0,
      fonts: resources.fonts?.length || 0,
    };

    // Check resource counts
    if (counts.scripts > budgets.maxScripts) {
      violations.push({
        category: 'resources',
        metric: 'scripts',
        actual: counts.scripts,
        budget: budgets.maxScripts,
        overage: counts.scripts - budgets.maxScripts,
        timestamp: Date.now(),
      });
    }

    if (counts.styles > budgets.maxStyles) {
      violations.push({
        category: 'resources',
        metric: 'styles',
        actual: counts.styles,
        budget: budgets.maxStyles,
        overage: counts.styles - budgets.maxStyles,
        timestamp: Date.now(),
      });
    }

    // Check total transfer size
    const totalSize = resources.totalTransferSize || 0;
    if (totalSize > budgets.totalTransferSize) {
      violations.push({
        category: 'resources',
        metric: 'transferSize',
        actual: totalSize,
        budget: budgets.totalTransferSize,
        overage: totalSize - budgets.totalTransferSize,
        timestamp: Date.now(),
      });
    }

    const passed = violations.length === 0;
    this.state.resources = { passed, violations, warnings };

    return { passed, violations, warnings };
  }

  // ==========================================================================
  // Budget Reporting
  // ==========================================================================

  /**
   * Get complete budget status
   * @returns {Object}
   */
  getStatus() {
    const totalViolations = this.violations.length;
    const totalWarnings = this.warnings.length;
    const overallPassed = Object.values(this.state).every(s => s.passed);

    return freeze({
      overall: overallPassed ? 'pass' : 'fail',
      violations: totalViolations,
      warnings: totalWarnings,
      uptime: Date.now() - this.startTime,
      state: { ...this.state },
      budgets: { ...this.budgets },
    });
  }

  /**
   * Get budget report
   * @returns {Object}
   */
  getReport() {
    return freeze({
      timestamp: Date.now(),
      uptime: Date.now() - this.startTime,
      status: this.getStatus(),
      violations: [...this.violations],
      warnings: [...this.warnings],
      recommendations: this._generateRecommendations(),
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
   * Clear violations and warnings
   */
  clear() {
    this.violations = [];
    this.warnings = [];
    
    if (this.enableLogging) {
      console.log('[PerformanceBudget] Cleared violations and warnings');
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Merge custom budgets with defaults
   * @private
   */
  _mergeBudgets(defaults, custom) {
    const merged = { ...defaults };

    for (const category in custom) {
      if (defaults[category]) {
        merged[category] = { ...defaults[category], ...custom[category] };
      }
    }

    return freeze(merged);
  }

  /**
   * Record violation
   * @private
   */
  _recordViolation(violation) {
    this.violations.push(violation);

    if (this.onViolation) {
      try {
        this.onViolation(violation);
      } catch (error) {
        console.error('[PerformanceBudget] Violation callback error:', error);
      }
    }

    if (this.enableLogging) {
      console.warn(`[PerformanceBudget] VIOLATION: ${violation.category}.${violation.metric}`,
        `actual: ${violation.actual}, budget: ${violation.budget}`);
    }
  }

  /**
   * Record warning
   * @private
   */
  _recordWarning(warning) {
    this.warnings.push(warning);

    if (this.onWarning) {
      try {
        this.onWarning(warning);
      } catch (error) {
        console.error('[PerformanceBudget] Warning callback error:', error);
      }
    }

    if (this.enableLogging) {
      console.warn(`[PerformanceBudget] WARNING: ${warning.category}.${warning.metric}`,
        `actual: ${warning.actual}, budget: ${warning.budget}`);
    }
  }

  /**
   * Generate performance recommendations
   * @private
   */
  _generateRecommendations() {
    const recommendations = [];

    // Startup recommendations
    if (!this.state.startup.passed) {
      const startupViolations = this.state.startup.violations;
      if (startupViolations.some(v => v.metric === 'moduleLoad')) {
        recommendations.push({
          category: 'startup',
          issue: 'Slow module loading',
          suggestion: 'Implement lazy loading for non-critical modules',
          priority: 'high',
        });
      }
      if (startupViolations.some(v => v.metric === 'total')) {
        recommendations.push({
          category: 'startup',
          issue: 'Slow total startup time',
          suggestion: 'Profile startup sequence and eliminate blocking operations',
          priority: 'critical',
        });
      }
    }

    // Memory recommendations
    if (!this.state.memory.passed) {
      recommendations.push({
        category: 'memory',
        issue: 'High memory usage',
        suggestion: 'Review for memory leaks, large data structures, or retained references',
        priority: 'high',
      });
    }

    // Runtime recommendations
    if (!this.state.runtime.passed) {
      const runtimeViolations = this.state.runtime.violations;
      if (runtimeViolations.some(v => v.metric === 'fps')) {
        recommendations.push({
          category: 'runtime',
          issue: 'Low FPS',
          suggestion: 'Optimize render loop, reduce draw calls, or implement adaptive quality',
          priority: 'medium',
        });
      }
    }

    return recommendations;
  }
}

// Export
module.exports = { PerformanceBudget, DEFAULT_BUDGETS };

if (typeof window !== 'undefined') {
  window.PerformanceBudget = PerformanceBudget;
  console.log('📦 PerformanceBudget loaded');
}

