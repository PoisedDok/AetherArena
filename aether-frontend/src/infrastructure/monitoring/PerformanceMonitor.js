'use strict';

/**
 * @.architecture
 * 
 * Incoming: Constructor options (enableLogging/thresholds), direct method calls (start/end/measure/measureAsync/getStats/getAllStats/getSummary/getRenderTiming/getResourceTiming/clear/exportJSON), functions to measure --- {method_calls, object | function}
 * Processing: Initialize measurements Map, marks Map, summary stats (totalOperations/slowOperations/criticalOperations), check Performance API availability, create performance.mark (start/end), create performance.measure, get duration from Performance API or Date.now() fallback, record measurements with statistics (count/total/avg/min/max/last/slowCount/criticalCount), compare against thresholds (slow=100ms, critical=1000ms), track summary, get render timing (first-paint/first-contentful-paint/domContentLoaded/loadComplete), get resource timing, clear marks/measures, export to JSON --- {11 jobs: JOB_GET_STATE, JOB_CLEAR_STATE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_GET_STATE, JOB_START, JOB_STOP, JOB_STRINGIFY_JSON, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: Return values (duration/stats/summary/renderTiming/resourceTiming/JSON), console.warn for slow/critical operations, window.PerformanceMonitor global --- {number | object | array | string | class_reference, javascript_object | global}
 * 
 * 
 * @module infrastructure/monitoring/PerformanceMonitor
 * 
 * PerformanceMonitor - Operation timing and performance tracking
 * ============================================================================
 * Production-grade performance monitoring:
 * - Operation timing with marks and measures
 * - Automatic threshold warnings
 * - Performance budgets
 * - Render timing
 * - Resource timing
 */

const { freeze } = Object;

class PerformanceMonitor {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.thresholds = options.thresholds || {
      slow: 100,      // Slow operation > 100ms
      critical: 1000  // Critical operation > 1000ms
    };
    
    // Measurements storage
    this.measurements = new Map();
    this.marks = new Map();
    this.summary = {
      totalOperations: 0,
      slowOperations: 0,
      criticalOperations: 0
    };
    
    // Check Performance API availability
    this.available = typeof performance !== 'undefined' &&
                     typeof performance.mark === 'function' &&
                     typeof performance.measure === 'function';
    
    if (!this.available) {
      console.warn('[PerformanceMonitor] Performance API not available');
    }
  }

  /**
   * Start timing operation
   * @param {string} name - Operation name
   * @returns {string} Mark name
   */
  start(name) {
    const markName = `${name}_start`;
    
    if (this.available) {
      try {
        performance.mark(markName);
      } catch (error) {
        console.error(`[PerformanceMonitor] Failed to mark ${markName}:`, error);
      }
    }
    
    this.marks.set(markName, Date.now());
    
    if (this.enableLogging) {
      console.log(`[PerformanceMonitor] Started: ${name}`);
    }
    
    return markName;
  }

  /**
   * End timing operation
   * @param {string} name - Operation name
   * @returns {number|null} Duration in milliseconds
   */
  end(name) {
    const startMarkName = `${name}_start`;
    const endMarkName = `${name}_end`;
    const measureName = name;
    
    let duration = null;
    
    if (this.available) {
      try {
        performance.mark(endMarkName);
        performance.measure(measureName, startMarkName, endMarkName);
        
        const entries = performance.getEntriesByName(measureName, 'measure');
        if (entries.length > 0) {
          duration = entries[entries.length - 1].duration;
        }
        
        // Cleanup marks and measures
        performance.clearMarks(startMarkName);
        performance.clearMarks(endMarkName);
        performance.clearMeasures(measureName);
      } catch (error) {
        console.error(`[PerformanceMonitor] Failed to measure ${name}:`, error);
      }
    }
    
    // Fallback to timestamp-based measurement
    if (duration === null) {
      const startTime = this.marks.get(startMarkName);
      if (startTime) {
        duration = Date.now() - startTime;
      }
    }
    
    if (duration !== null) {
      this._recordMeasurement(name, duration);
    }
    
    this.marks.delete(startMarkName);
    
    if (this.enableLogging) {
      console.log(`[PerformanceMonitor] Ended: ${name} (${duration}ms)`);
    }
    
    return duration;
  }

  /**
   * Measure synchronous function
   * @param {string} name - Operation name
   * @param {Function} fn - Function to measure
   * @returns {*} Function result
   */
  measure(name, fn) {
    this.start(name);
    
    try {
      const result = fn();
      this.end(name);
      return result;
    } catch (error) {
      this.end(name);
      throw error;
    }
  }

  /**
   * Measure asynchronous function
   * @param {string} name - Operation name
   * @param {Function} fn - Async function to measure
   * @returns {Promise<*>} Function result
   */
  async measureAsync(name, fn) {
    this.start(name);
    
    try {
      const result = await fn();
      this.end(name);
      return result;
    } catch (error) {
      this.end(name);
      throw error;
    }
  }

  /**
   * Get measurement statistics for operation
   * @param {string} name - Operation name
   * @returns {Object|null}
   */
  getStats(name) {
    const measurement = this.measurements.get(name);
    
    if (!measurement) {
      return null;
    }
    
    return freeze({
      name: measurement.name,
      count: measurement.count,
      total: measurement.total,
      avg: measurement.avg,
      min: measurement.min,
      max: measurement.max,
      last: measurement.last,
      slowCount: measurement.slowCount,
      criticalCount: measurement.criticalCount
    });
  }

  /**
   * Get all measurements
   * @returns {Array<Object>}
   */
  getAllStats() {
    const stats = [];
    
    for (const measurement of this.measurements.values()) {
      stats.push({
        name: measurement.name,
        count: measurement.count,
        total: measurement.total,
        avg: measurement.avg,
        min: measurement.min,
        max: measurement.max,
        last: measurement.last,
        slowCount: measurement.slowCount,
        criticalCount: measurement.criticalCount
      });
    }
    
    return freeze(stats);
  }

  /**
   * Get summary statistics
   * @returns {Object}
   */
  getSummary() {
    return freeze({
      totalOperations: this.summary.totalOperations,
      slowOperations: this.summary.slowOperations,
      criticalOperations: this.summary.criticalOperations,
      slowPercentage: this.summary.totalOperations > 0
        ? (this.summary.slowOperations / this.summary.totalOperations * 100).toFixed(2)
        : 0,
      criticalPercentage: this.summary.totalOperations > 0
        ? (this.summary.criticalOperations / this.summary.totalOperations * 100).toFixed(2)
        : 0,
      uniqueOperations: this.measurements.size
    });
  }

  /**
   * Get render timing information
   * @returns {Object|null}
   */
  getRenderTiming() {
    if (!this.available || !performance.getEntriesByType) {
      return null;
    }
    
    try {
      const paint = performance.getEntriesByType('paint');
      const navigation = performance.getEntriesByType('navigation')[0];
      
      return freeze({
        firstPaint: paint.find(p => p.name === 'first-paint')?.startTime || null,
        firstContentfulPaint: paint.find(p => p.name === 'first-contentful-paint')?.startTime || null,
        domContentLoaded: navigation?.domContentLoadedEventEnd || null,
        loadComplete: navigation?.loadEventEnd || null
      });
    } catch (error) {
      console.error('[PerformanceMonitor] Failed to get render timing:', error);
      return null;
    }
  }

  /**
   * Get resource timing information
   * @returns {Array<Object>}
   */
  getResourceTiming() {
    if (!this.available || !performance.getEntriesByType) {
      return [];
    }
    
    try {
      const resources = performance.getEntriesByType('resource');
      
      return resources.map(resource => freeze({
        name: resource.name,
        type: resource.initiatorType,
        duration: resource.duration,
        size: resource.transferSize || 0,
        startTime: resource.startTime
      }));
    } catch (error) {
      console.error('[PerformanceMonitor] Failed to get resource timing:', error);
      return [];
    }
  }

  /**
   * Clear all measurements
   */
  clear() {
    this.measurements.clear();
    this.marks.clear();
    this.summary = {
      totalOperations: 0,
      slowOperations: 0,
      criticalOperations: 0
    };
    
    if (this.available) {
      try {
        performance.clearMarks();
        performance.clearMeasures();
      } catch (error) {
        console.error('[PerformanceMonitor] Failed to clear:', error);
      }
    }
    
    if (this.enableLogging) {
      console.log('[PerformanceMonitor] Cleared all measurements');
    }
  }

  /**
   * Export measurements to JSON
   * @returns {string}
   */
  exportJSON() {
    const data = {
      summary: this.getSummary(),
      measurements: this.getAllStats(),
      renderTiming: this.getRenderTiming(),
      timestamp: Date.now()
    };
    
    return JSON.stringify(data, null, 2);
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Record measurement
   * @private
   */
  _recordMeasurement(name, duration) {
    let measurement = this.measurements.get(name);
    
    if (!measurement) {
      measurement = {
        name,
        count: 0,
        total: 0,
        avg: 0,
        min: Infinity,
        max: 0,
        last: 0,
        slowCount: 0,
        criticalCount: 0
      };
      this.measurements.set(name, measurement);
    }
    
    // Update statistics
    measurement.count++;
    measurement.total += duration;
    measurement.avg = measurement.total / measurement.count;
    measurement.min = Math.min(measurement.min, duration);
    measurement.max = Math.max(measurement.max, duration);
    measurement.last = duration;
    
    // Track slow/critical operations
    if (duration > this.thresholds.critical) {
      measurement.criticalCount++;
      this.summary.criticalOperations++;
      
      console.warn(`[PerformanceMonitor] CRITICAL: ${name} took ${duration}ms`);
    } else if (duration > this.thresholds.slow) {
      measurement.slowCount++;
      this.summary.slowOperations++;
      
      if (this.enableLogging) {
        console.warn(`[PerformanceMonitor] SLOW: ${name} took ${duration}ms`);
      }
    }
    
    this.summary.totalOperations++;
  }
}

// Export
module.exports = { PerformanceMonitor };

if (typeof window !== 'undefined') {
  window.PerformanceMonitor = PerformanceMonitor;
  console.log('📦 PerformanceMonitor loaded');
}

