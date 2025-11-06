'use strict';

/**
 * @.architecture
 * 
 * Incoming: Constructor options (enableLogging/budget), direct method calls (startPhase/endPhase/measureSync/measureAsync/markMilestone/completeStartup/getMetrics/getSummary/exportJSON/logSummary), functions to measure --- {method_calls, object | function}
 * Processing: Initialize PHASES (preload/domReady/configLoad/servicesInit/moduleLoad/controllerInit/bootstrap/firstRender/interactive), MILESTONES (appStart/domReady/eventBusReady/configLoaded/servicesRegistered/modulesLoaded/controllerInitialized/firstPaint/firstContentfulPaint/interactive/complete), track startTime, phases Map, milestones Map, marks Map, check Performance API availability, create performance.mark/performance.measure, track phase duration (Date.now()), mark milestones, complete startup with web vitals capture, get navigation timing (domLoading/domInteractive/domContentLoaded/loadComplete), get paint timing (first-paint/first-contentful-paint), get resource timing summary (count by type/duration/transferSize), generate metrics (phases/milestones/navigation/paint/resources/webVitals), generate summary (slowestPhases top 5, budget comparison), export to JSON, log summary --- {11 jobs: JOB_GET_STATE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_GET_STATE, JOB_START, JOB_STOP, JOB_STRINGIFY_JSON, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: Return values (duration/metrics/summary/JSON), console logs (phases/milestones/summary), window.StartupProfiler global, window.__STARTUP_PROFILER__ singleton instance --- {number | object | string | class_reference, javascript_object | global}
 * 
 * 
 * @module infrastructure/monitoring/StartupProfiler
 * 
 * StartupProfiler - Application Startup Performance Profiling
 * ============================================================================
 * Production-grade startup profiling with:
 * - Detailed phase timing
 * - Startup milestone tracking
 * - Budget validation (< 2s)
 * - Bottleneck identification
 * - Performance reporting
 */

const { freeze } = Object;

/**
 * Startup phases
 */
const PHASES = freeze({
  PRELOAD: 'preload',
  DOM_READY: 'domReady',
  CONFIG_LOAD: 'configLoad',
  SERVICES_INIT: 'servicesInit',
  MODULE_LOAD: 'moduleLoad',
  CONTROLLER_INIT: 'controllerInit',
  BOOTSTRAP: 'bootstrap',
  FIRST_RENDER: 'firstRender',
  INTERACTIVE: 'interactive',
});

/**
 * Startup milestones
 */
const MILESTONES = freeze({
  APP_START: 'appStart',
  DOM_READY: 'domReady',
  EVENT_BUS_READY: 'eventBusReady',
  CONFIG_LOADED: 'configLoaded',
  SERVICES_REGISTERED: 'servicesRegistered',
  MODULES_LOADED: 'modulesLoaded',
  CONTROLLER_INITIALIZED: 'controllerInitialized',
  FIRST_PAINT: 'firstPaint',
  FIRST_CONTENTFUL_PAINT: 'firstContentfulPaint',
  INTERACTIVE: 'interactive',
  COMPLETE: 'complete',
});

class StartupProfiler {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging !== false;
    this.budget = options.budget || 2000; // 2s default budget
    
    // Timing data
    this.startTime = this._getTime();
    this.phases = new Map();
    this.milestones = new Map();
    this.marks = new Map();
    
    // State
    this.isStartupComplete = false;
    this.currentPhase = null;

    // Performance API availability
    this.hasPerformanceAPI = typeof performance !== 'undefined' &&
                              typeof performance.mark === 'function';

    // Mark app start
    this.markMilestone(MILESTONES.APP_START);

    if (this.enableLogging) {
      console.log('[StartupProfiler] Initialized - tracking startup performance');
    }
  }

  // ==========================================================================
  // Phase Tracking
  // ==========================================================================

  /**
   * Start tracking a phase
   * @param {string} phase - Phase name
   */
  startPhase(phase) {
    if (this.isStartupComplete) {
      console.warn('[StartupProfiler] Cannot start phase - startup already complete');
      return;
    }

    const phaseData = {
      name: phase,
      startTime: this._getTime(),
      startMark: this._mark(`${phase}_start`),
      endTime: null,
      endMark: null,
      duration: null,
    };

    this.phases.set(phase, phaseData);
    this.currentPhase = phase;

    if (this.enableLogging) {
      console.log(`[StartupProfiler] ⏱️  Phase started: ${phase}`);
    }
  }

  /**
   * End tracking a phase
   * @param {string} phase - Phase name
   * @returns {number|null} Phase duration
   */
  endPhase(phase) {
    const phaseData = this.phases.get(phase);
    
    if (!phaseData) {
      console.warn(`[StartupProfiler] Phase not found: ${phase}`);
      return null;
    }

    if (phaseData.endTime !== null) {
      console.warn(`[StartupProfiler] Phase already ended: ${phase}`);
      return phaseData.duration;
    }

    phaseData.endTime = this._getTime();
    phaseData.endMark = this._mark(`${phase}_end`);
    phaseData.duration = phaseData.endTime - phaseData.startTime;

    // Measure with Performance API if available
    if (this.hasPerformanceAPI) {
      try {
        performance.measure(phase, phaseData.startMark, phaseData.endMark);
      } catch (error) {
        // Ignore measurement errors
      }
    }

    if (this.currentPhase === phase) {
      this.currentPhase = null;
    }

    if (this.enableLogging) {
      console.log(`[StartupProfiler] ✅ Phase completed: ${phase} (${phaseData.duration}ms)`);
    }

    return phaseData.duration;
  }

  /**
   * Measure a synchronous operation
   * @param {string} name - Operation name
   * @param {Function} fn - Function to measure
   * @returns {*} Function result
   */
  measureSync(name, fn) {
    this.startPhase(name);
    
    try {
      const result = fn();
      this.endPhase(name);
      return result;
    } catch (error) {
      this.endPhase(name);
      throw error;
    }
  }

  /**
   * Measure an asynchronous operation
   * @param {string} name - Operation name
   * @param {Function} fn - Async function to measure
   * @returns {Promise<*>} Function result
   */
  async measureAsync(name, fn) {
    this.startPhase(name);
    
    try {
      const result = await fn();
      this.endPhase(name);
      return result;
    } catch (error) {
      this.endPhase(name);
      throw error;
    }
  }

  // ==========================================================================
  // Milestone Tracking
  // ==========================================================================

  /**
   * Mark a milestone
   * @param {string} milestone - Milestone name
   * @returns {number} Timestamp
   */
  markMilestone(milestone) {
    const timestamp = this._getTime();
    const elapsed = timestamp - this.startTime;

    this.milestones.set(milestone, {
      name: milestone,
      timestamp,
      elapsed,
    });

    this._mark(milestone);

    if (this.enableLogging) {
      console.log(`[StartupProfiler] 🎯 Milestone: ${milestone} (+${elapsed}ms)`);
    }

    // Special handling for complete milestone
    if (milestone === MILESTONES.COMPLETE) {
      this.completeStartup();
    }

    return timestamp;
  }

  /**
   * Complete startup tracking
   */
  completeStartup() {
    if (this.isStartupComplete) {
      return;
    }

    this.isStartupComplete = true;
    const totalTime = this._getTime() - this.startTime;

    // Capture web vitals if available
    this._captureWebVitals();

    if (this.enableLogging) {
      console.log(`[StartupProfiler] 🏁 Startup complete: ${totalTime}ms`);
      
      if (totalTime > this.budget) {
        console.warn(`[StartupProfiler] ⚠️  Startup exceeded budget: ${totalTime}ms > ${this.budget}ms`);
      } else {
        console.log(`[StartupProfiler] ✅ Startup within budget: ${totalTime}ms < ${this.budget}ms`);
      }
    }
  }

  // ==========================================================================
  // Performance API Integration
  // ==========================================================================

  /**
   * Get Navigation Timing data
   * @returns {Object|null}
   */
  getNavigationTiming() {
    if (!this.hasPerformanceAPI || !performance.timing) {
      return null;
    }

    const timing = performance.timing;
    const navigationStart = timing.navigationStart;

    return freeze({
      domLoading: timing.domLoading - navigationStart,
      domInteractive: timing.domInteractive - navigationStart,
      domContentLoaded: timing.domContentLoadedEventEnd - navigationStart,
      loadComplete: timing.loadEventEnd - navigationStart,
      domContentLoadedEvent: timing.domContentLoadedEventEnd - timing.domContentLoadedEventStart,
      loadEvent: timing.loadEventEnd - timing.loadEventStart,
    });
  }

  /**
   * Get Paint Timing data
   * @returns {Object|null}
   */
  getPaintTiming() {
    if (!this.hasPerformanceAPI || !performance.getEntriesByType) {
      return null;
    }

    try {
      const paintEntries = performance.getEntriesByType('paint');
      const result = {};

      for (const entry of paintEntries) {
        if (entry.name === 'first-paint') {
          result.firstPaint = entry.startTime;
        } else if (entry.name === 'first-contentful-paint') {
          result.firstContentfulPaint = entry.startTime;
        }
      }

      return Object.keys(result).length > 0 ? freeze(result) : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get Resource Timing summary
   * @returns {Object|null}
   */
  getResourceTiming() {
    if (!this.hasPerformanceAPI || !performance.getEntriesByType) {
      return null;
    }

    try {
      const resources = performance.getEntriesByType('resource');
      
      const summary = {
        total: resources.length,
        byType: {},
        totalDuration: 0,
        totalTransferSize: 0,
      };

      for (const resource of resources) {
        const type = resource.initiatorType || 'other';
        
        if (!summary.byType[type]) {
          summary.byType[type] = {
            count: 0,
            duration: 0,
            size: 0,
          };
        }

        summary.byType[type].count++;
        summary.byType[type].duration += resource.duration;
        summary.byType[type].size += resource.transferSize || 0;
        
        summary.totalDuration += resource.duration;
        summary.totalTransferSize += resource.transferSize || 0;
      }

      return freeze(summary);
    } catch (error) {
      return null;
    }
  }

  // ==========================================================================
  // Reporting
  // ==========================================================================

  /**
   * Get complete startup metrics
   * @returns {Object}
   */
  getMetrics() {
    const totalTime = this.isStartupComplete 
      ? this._getTime() - this.startTime
      : null;

    // Convert phases to array
    const phases = [];
    for (const [name, data] of this.phases.entries()) {
      phases.push({
        name,
        duration: data.duration,
        startTime: data.startTime - this.startTime,
        endTime: data.endTime ? data.endTime - this.startTime : null,
      });
    }

    // Convert milestones to array
    const milestones = [];
    for (const [name, data] of this.milestones.entries()) {
      milestones.push({
        name,
        elapsed: data.elapsed,
        timestamp: data.timestamp,
      });
    }

    return freeze({
      total: totalTime,
      isComplete: this.isStartupComplete,
      budget: this.budget,
      withinBudget: totalTime !== null ? totalTime <= this.budget : null,
      phases,
      milestones,
      navigation: this.getNavigationTiming(),
      paint: this.getPaintTiming(),
      resources: this.getResourceTiming(),
      webVitals: this._getWebVitals(),
    });
  }

  /**
   * Get performance summary
   * @returns {Object}
   */
  getSummary() {
    const metrics = this.getMetrics();
    
    const slowestPhases = [...(metrics.phases || [])]
      .filter(p => p.duration !== null)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5);

    return freeze({
      total: metrics.total,
      budget: metrics.budget,
      withinBudget: metrics.withinBudget,
      overbudget: metrics.total > metrics.budget ? metrics.total - metrics.budget : 0,
      slowestPhases,
      firstPaint: metrics.paint?.firstPaint || null,
      firstContentfulPaint: metrics.paint?.firstContentfulPaint || null,
      domContentLoaded: metrics.navigation?.domContentLoaded || null,
    });
  }

  /**
   * Export metrics as JSON
   * @returns {string}
   */
  exportJSON() {
    return JSON.stringify(this.getMetrics(), null, 2);
  }

  /**
   * Log summary to console
   */
  logSummary() {
    const summary = this.getSummary();

    console.group('[StartupProfiler] Performance Summary');
    console.log(`Total time: ${summary.total}ms`);
    console.log(`Budget: ${summary.budget}ms`);
    console.log(`Status: ${summary.withinBudget ? '✅ Pass' : '❌ Fail'}`);
    
    if (summary.overbudget > 0) {
      console.warn(`Over budget by: ${summary.overbudget}ms`);
    }

    if (summary.slowestPhases.length > 0) {
      console.log('Slowest phases:');
      for (const phase of summary.slowestPhases) {
        console.log(`  - ${phase.name}: ${phase.duration}ms`);
      }
    }

    if (summary.firstPaint) {
      console.log(`First Paint: ${summary.firstPaint}ms`);
    }
    if (summary.firstContentfulPaint) {
      console.log(`First Contentful Paint: ${summary.firstContentfulPaint}ms`);
    }

    console.groupEnd();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Get current time
   * @private
   */
  _getTime() {
    // Always use Date.now() for consistency
    // performance.now() is relative to navigation start, while Date.now() is absolute
    // Mixing them causes huge timestamp differences
    return Date.now();
  }

  /**
   * Create performance mark
   * @private
   */
  _mark(name) {
    const markName = `startup:${name}`;
    
    if (this.hasPerformanceAPI) {
      try {
        performance.mark(markName);
      } catch (error) {
        // Ignore mark errors
      }
    }

    this.marks.set(name, this._getTime());
    return markName;
  }

  /**
   * Capture web vitals
   * @private
   */
  _captureWebVitals() {
    // This will be populated by PerformanceObserver if available
    // For now, capture basic paint timing
    const paint = this.getPaintTiming();
    
    if (paint) {
      if (paint.firstPaint) {
        this.markMilestone(MILESTONES.FIRST_PAINT);
      }
      if (paint.firstContentfulPaint) {
        this.markMilestone(MILESTONES.FIRST_CONTENTFUL_PAINT);
      }
    }
  }

  /**
   * Get web vitals
   * @private
   */
  _getWebVitals() {
    return {
      FCP: this.milestones.get(MILESTONES.FIRST_CONTENTFUL_PAINT)?.elapsed || null,
      TTI: this.milestones.get(MILESTONES.INTERACTIVE)?.elapsed || null,
    };
  }
}

// Export
module.exports = { StartupProfiler, PHASES, MILESTONES };

if (typeof window !== 'undefined') {
  window.StartupProfiler = StartupProfiler;
  window.__STARTUP_PROFILER__ = new StartupProfiler();
  console.log('📦 StartupProfiler loaded');
}

