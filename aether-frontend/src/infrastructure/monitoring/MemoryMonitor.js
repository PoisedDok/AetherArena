'use strict';

/**
 * @.architecture
 * 
 * Incoming: Constructor options (enableLogging/budget/sampleInterval/historySize/onWarning/onCritical/onBudgetExceeded/onLeakDetected), direct method calls (start/stop/sample/forceGC/getCurrentMemory/getStats/getTrend/getLeaks/isHealthy/getReport/exportJSON/logStatus/clear) --- {method_calls, object | function}
 * Processing: Initialize THRESHOLDS (BUDGET=400MB, WARNING=350MB, CRITICAL=380MB, LEAK_THRESHOLD=10MB, MAX_GROWTH_RATE=5MB/min), track samples array, leaks array, pressureEvents array, check performance.memory API availability, take memory samples at interval (usedJSHeapSize/totalJSHeapSize/jsHeapSizeLimit), trim history to historySize (default 100), track currentMemory/peakMemory/lastSample, check thresholds (budget/critical/warning), detect leaks (sustained growth>10MB over 20 samples), calculate growth rate (bytes/min), calculate statistics (avg/median/min/max/growthRate), determine trend (growing/stable/declining), record pressure events (warning/critical/budget_exceeded), trigger callbacks (onWarning/onCritical/onBudgetExceeded/onLeakDetected), force GC (if available with --expose-gc), generate report, export to JSON, log status, clear history --- {13 jobs: JOB_GET_STATE, JOB_CLEAR_STATE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_START, JOB_STOP, JOB_STRINGIFY_JSON, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_UPDATE_STATE}
 * Outgoing: Return values (sample/stats/trend/leaks/report/JSON), callbacks (onWarning/onCritical/onBudgetExceeded/onLeakDetected), console logs/warns/errors for memory status/leaks/pressure, window.MemoryMonitor global --- {object | array | string | boolean | class_reference, javascript_object | global}
 * 
 * 
 * @module infrastructure/monitoring/MemoryMonitor
 * 
 * MemoryMonitor - Memory Usage Monitoring and Leak Detection
 * ============================================================================
 * Production-grade memory monitoring with:
 * - Real-time memory tracking
 * - Memory budget enforcement (< 400MB)
 * - Leak detection
 * - Growth rate monitoring
 * - Automatic garbage collection hints
 * - Memory pressure alerts
 */

const { freeze } = Object;

/**
 * Memory thresholds (bytes)
 */
const THRESHOLDS = freeze({
  BUDGET: 400 * 1024 * 1024,        // 400MB total budget
  WARNING: 350 * 1024 * 1024,       // 350MB warning level
  CRITICAL: 380 * 1024 * 1024,      // 380MB critical level
  LEAK_THRESHOLD: 10 * 1024 * 1024, // 10MB potential leak
  MAX_GROWTH_RATE: 5 * 1024 * 1024, // 5MB/min growth rate
});

class MemoryMonitor {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging !== false;
    this.budget = options.budget || THRESHOLDS.BUDGET;
    this.sampleInterval = options.sampleInterval || 5000; // 5s default
    this.historySize = options.historySize || 100;
    
    // Memory tracking
    this.samples = [];
    this.leaks = [];
    this.pressureEvents = [];
    
    // State
    this.currentMemory = null;
    this.peakMemory = 0;
    this.lastSample = null;
    this.isMonitoring = false;
    this.monitoringInterval = null;
    
    // Callbacks
    this.onWarning = options.onWarning || null;
    this.onCritical = options.onCritical || null;
    this.onBudgetExceeded = options.onBudgetExceeded || null;
    this.onLeakDetected = options.onLeakDetected || null;

    // Check Memory API availability
    this.hasMemoryAPI = typeof performance !== 'undefined' && 
                        performance.memory !== undefined;

    if (!this.hasMemoryAPI) {
      console.warn('[MemoryMonitor] Performance.memory API not available');
    }

    if (this.enableLogging) {
      console.log('[MemoryMonitor] Initialized with budget:', this._formatBytes(this.budget));
    }
  }

  // ==========================================================================
  // Monitoring Control
  // ==========================================================================

  /**
   * Start memory monitoring
   */
  start() {
    if (this.isMonitoring) {
      return;
    }

    if (!this.hasMemoryAPI) {
      console.warn('[MemoryMonitor] Cannot start - Memory API not available');
      return;
    }

    this.isMonitoring = true;
    this._takeSample();

    this.monitoringInterval = setInterval(() => {
      this._takeSample();
      this._checkThresholds();
      this._detectLeaks();
    }, this.sampleInterval);

    if (this.enableLogging) {
      console.log('[MemoryMonitor] Started monitoring');
    }
  }

  /**
   * Stop memory monitoring
   */
  stop() {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    if (this.enableLogging) {
      console.log('[MemoryMonitor] Stopped monitoring');
    }
  }

  /**
   * Take immediate memory sample
   * @returns {Object|null} Memory snapshot
   */
  sample() {
    return this._takeSample();
  }

  /**
   * Force garbage collection (if available)
   */
  forceGC() {
    // GC is only available in development with --expose-gc flag
    if (typeof global !== 'undefined' && global.gc) {
      if (this.enableLogging) {
        console.log('[MemoryMonitor] Forcing garbage collection');
      }
      try {
        global.gc();
      } catch (error) {
        console.warn('[MemoryMonitor] GC failed:', error);
      }
    } else {
      if (this.enableLogging) {
        console.log('[MemoryMonitor] GC not available (requires --expose-gc)');
      }
    }
  }

  // ==========================================================================
  // Memory Analysis
  // ==========================================================================

  /**
   * Get current memory usage
   * @returns {Object|null}
   */
  getCurrentMemory() {
    if (!this.hasMemoryAPI) {
      return null;
    }

    const mem = performance.memory;

    return freeze({
      used: mem.usedJSHeapSize,
      total: mem.totalJSHeapSize,
      limit: mem.jsHeapSizeLimit,
      percentage: (mem.usedJSHeapSize / this.budget) * 100,
      timestamp: Date.now(),
    });
  }

  /**
   * Get memory statistics
   * @returns {Object}
   */
  getStats() {
    if (this.samples.length === 0) {
      return null;
    }

    const usedSamples = this.samples.map(s => s.used);
    const totalSamples = this.samples.map(s => s.total);

    const stats = {
      current: this.currentMemory,
      peak: this.peakMemory,
      average: this._average(usedSamples),
      median: this._median(usedSamples),
      min: Math.min(...usedSamples),
      max: Math.max(...usedSamples),
      budget: this.budget,
      withinBudget: this.currentMemory ? this.currentMemory.used <= this.budget : null,
      overBudget: this.currentMemory && this.currentMemory.used > this.budget 
        ? this.currentMemory.used - this.budget 
        : 0,
      samples: this.samples.length,
      leaks: this.leaks.length,
      pressureEvents: this.pressureEvents.length,
      growthRate: this._calculateGrowthRate(),
    };

    return freeze(stats);
  }

  /**
   * Get memory trend
   * @returns {string} 'growing' | 'stable' | 'declining'
   */
  getTrend() {
    if (this.samples.length < 10) {
      return 'insufficient-data';
    }

    const recent = this.samples.slice(-10);
    const older = this.samples.slice(-20, -10);

    if (older.length === 0) {
      return 'insufficient-data';
    }

    const recentAvg = this._average(recent.map(s => s.used));
    const olderAvg = this._average(older.map(s => s.used));

    const diff = recentAvg - olderAvg;
    const threshold = 1 * 1024 * 1024; // 1MB threshold

    if (diff > threshold) {
      return 'growing';
    } else if (diff < -threshold) {
      return 'declining';
    } else {
      return 'stable';
    }
  }

  /**
   * Get leak report
   * @returns {Array}
   */
  getLeaks() {
    return freeze([...this.leaks]);
  }

  /**
   * Check if memory is healthy
   * @returns {boolean}
   */
  isHealthy() {
    if (!this.currentMemory) {
      return true;
    }

    const withinBudget = this.currentMemory.used <= this.budget;
    const trend = this.getTrend();
    const hasLeaks = this.leaks.length > 0;

    return withinBudget && trend !== 'growing' && !hasLeaks;
  }

  // ==========================================================================
  // Reporting
  // ==========================================================================

  /**
   * Get memory report
   * @returns {Object}
   */
  getReport() {
    return freeze({
      timestamp: Date.now(),
      healthy: this.isHealthy(),
      current: this.getCurrentMemory(),
      stats: this.getStats(),
      trend: this.getTrend(),
      leaks: this.getLeaks(),
      pressureEvents: [...this.pressureEvents],
      history: this.samples.slice(-20).map(s => ({
        used: s.used,
        total: s.total,
        percentage: (s.used / this.budget) * 100,
        timestamp: s.timestamp,
      })),
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
   * Log memory status
   */
  logStatus() {
    const stats = this.getStats();
    
    if (!stats) {
      console.log('[MemoryMonitor] No data available');
      return;
    }

    console.group('[MemoryMonitor] Memory Status');
    console.log(`Current: ${this._formatBytes(stats.current.used)} / ${this._formatBytes(this.budget)}`);
    console.log(`Peak: ${this._formatBytes(stats.peak)}`);
    console.log(`Average: ${this._formatBytes(stats.average)}`);
    console.log(`Budget status: ${stats.withinBudget ? '✅ Within budget' : '❌ Over budget'}`);
    
    if (stats.overBudget > 0) {
      console.warn(`Over budget by: ${this._formatBytes(stats.overBudget)}`);
    }

    console.log(`Trend: ${this.getTrend()}`);
    console.log(`Growth rate: ${this._formatBytes(stats.growthRate)}/min`);
    
    if (stats.leaks > 0) {
      console.warn(`⚠️  Potential leaks detected: ${stats.leaks}`);
    }

    console.groupEnd();
  }

  /**
   * Clear history
   */
  clear() {
    this.samples = [];
    this.leaks = [];
    this.pressureEvents = [];
    this.peakMemory = 0;
    this.lastSample = null;

    if (this.enableLogging) {
      console.log('[MemoryMonitor] Cleared history');
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Take memory sample
   * @private
   */
  _takeSample() {
    if (!this.hasMemoryAPI) {
      return null;
    }

    const mem = performance.memory;
    const sample = {
      used: mem.usedJSHeapSize,
      total: mem.totalJSHeapSize,
      limit: mem.jsHeapSizeLimit,
      timestamp: Date.now(),
    };

    this.samples.push(sample);
    
    // Trim history
    if (this.samples.length > this.historySize) {
      this.samples.shift();
    }

    this.currentMemory = {
      ...sample,
      percentage: (sample.used / this.budget) * 100,
    };

    // Update peak
    if (sample.used > this.peakMemory) {
      this.peakMemory = sample.used;
    }

    this.lastSample = sample;

    return freeze(sample);
  }

  /**
   * Check memory thresholds
   * @private
   */
  _checkThresholds() {
    if (!this.currentMemory) {
      return;
    }

    const used = this.currentMemory.used;

    // Budget exceeded
    if (used > this.budget) {
      this._recordPressureEvent('budget_exceeded', used);
      
      if (this.onBudgetExceeded) {
        try {
          this.onBudgetExceeded(this.currentMemory);
        } catch (error) {
          console.error('[MemoryMonitor] Budget exceeded callback error:', error);
        }
      }

      if (this.enableLogging) {
        console.error(`[MemoryMonitor] ❌ BUDGET EXCEEDED: ${this._formatBytes(used)} > ${this._formatBytes(this.budget)}`);
      }
    }
    // Critical level
    else if (used > THRESHOLDS.CRITICAL) {
      this._recordPressureEvent('critical', used);
      
      if (this.onCritical) {
        try {
          this.onCritical(this.currentMemory);
        } catch (error) {
          console.error('[MemoryMonitor] Critical callback error:', error);
        }
      }

      if (this.enableLogging) {
        console.warn(`[MemoryMonitor] ⚠️  CRITICAL: ${this._formatBytes(used)}`);
      }
    }
    // Warning level
    else if (used > THRESHOLDS.WARNING) {
      this._recordPressureEvent('warning', used);
      
      if (this.onWarning) {
        try {
          this.onWarning(this.currentMemory);
        } catch (error) {
          console.error('[MemoryMonitor] Warning callback error:', error);
        }
      }
    }
  }

  /**
   * Detect potential memory leaks
   * @private
   */
  _detectLeaks() {
    if (this.samples.length < 20) {
      return;
    }

    // Check for sustained growth
    const recent = this.samples.slice(-10);
    const older = this.samples.slice(-20, -10);

    const recentAvg = this._average(recent.map(s => s.used));
    const olderAvg = this._average(older.map(s => s.used));

    const growth = recentAvg - olderAvg;

    // Potential leak if sustained growth > threshold
    if (growth > THRESHOLDS.LEAK_THRESHOLD) {
      const leak = {
        detected: Date.now(),
        growth,
        rate: growth / (this.sampleInterval * 10 / 60000), // Growth per minute
        samples: recent.length,
      };

      this.leaks.push(leak);

      if (this.onLeakDetected) {
        try {
          this.onLeakDetected(leak);
        } catch (error) {
          console.error('[MemoryMonitor] Leak detected callback error:', error);
        }
      }

      if (this.enableLogging) {
        console.warn(`[MemoryMonitor] ⚠️  POTENTIAL LEAK: Growth of ${this._formatBytes(growth)} over ${recent.length} samples`);
      }
    }
  }

  /**
   * Calculate memory growth rate (bytes/minute)
   * @private
   */
  _calculateGrowthRate() {
    if (this.samples.length < 2) {
      return 0;
    }

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];

    const growth = last.used - first.used;
    const duration = (last.timestamp - first.timestamp) / 60000; // minutes

    return duration > 0 ? growth / duration : 0;
  }

  /**
   * Record memory pressure event
   * @private
   */
  _recordPressureEvent(level, used) {
    const event = {
      level,
      used,
      percentage: (used / this.budget) * 100,
      timestamp: Date.now(),
    };

    this.pressureEvents.push(event);

    // Keep only last 50 events
    if (this.pressureEvents.length > 50) {
      this.pressureEvents.shift();
    }
  }

  /**
   * Calculate average
   * @private
   */
  _average(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((sum, val) => sum + val, 0) / arr.length;
  }

  /**
   * Calculate median
   * @private
   */
  _median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Format bytes as human-readable
   * @private
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }
}

// Export
module.exports = { MemoryMonitor, THRESHOLDS };

if (typeof window !== 'undefined') {
  window.MemoryMonitor = MemoryMonitor;
  console.log('📦 MemoryMonitor loaded');
}

