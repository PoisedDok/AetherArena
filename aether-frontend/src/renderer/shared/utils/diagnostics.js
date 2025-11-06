'use strict';

/**
 * @.architecture
 *
 * Incoming: All modules (.start/.end/.measure/.trackFPS calls) --- {method_calls, javascript_api}
 * Processing: Performance monitoring - performance.mark/measure for timing, FPS tracking with frame deltas, memory usage via performance.memory, log level filtering (ERROR/WARN/INFO/DEBUG/TRACE), browser feature detection (localStorage/WebGL/WebWorker/etc), performance snapshots, history buffer (max 100 events) --- {5 jobs: JOB_TRACK_ENTITY, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: Return timing data (ms), FPS stats (min/max/avg), memory objects, feature flags --- {performance_types.*, {duration:number} | {fps:number} | {memory:object}}
 *
 *
 * @module renderer/shared/utils/diagnostics
 */

/**
 * Diagnostics - Performance and Debug Utilities
 * ============================================================================
 * Production-ready diagnostic utilities with:
 * - Performance measurement and profiling
 * - FPS tracking
 * - Memory monitoring
 * - Debug logging with levels
 * - Performance marks and measures
 * - Browser feature detection
 * 
 * Responsibilities:
 * - Track performance metrics
 * - Measure execution time
 * - Monitor FPS and frame times
 * - Provide debug logging
 * - Detect browser capabilities
 * - Performance profiling
 * 
 * Architecture:
 * - Singleton pattern for global state
 * - Performance API integration
 * - Conditional logging based on environment
 * - Production-ready error handling
 * 
 * @module renderer/shared/utils/diagnostics
 */

const { freeze } = Object;

// Configuration
const CONFIG = freeze({
  LOG_LEVELS: freeze({
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    TRACE: 4,
  }),
  FPS_SAMPLE_SIZE: 60,
  PERFORMANCE_BUFFER_SIZE: 100,
});

/**
 * Diagnostics Utility
 */
class Diagnostics {
  constructor() {
    // State
    this.logLevel = CONFIG.LOG_LEVELS.INFO;
    this.isDevelopment = false;
    this.measurements = new Map();
    this.fpsHistory = [];
    this.lastFrameTime = null;
    this.performanceMarks = new Set();

    // Detect environment
    if (typeof window !== 'undefined') {
      this.isDevelopment = window.__DEV__ || false;
      this.logLevel = this.isDevelopment ? CONFIG.LOG_LEVELS.DEBUG : CONFIG.LOG_LEVELS.WARN;
    }

    console.log('[Diagnostics] Initialized (level:', this._getLevelName(this.logLevel), ')');
  }

  /**
   * Set log level
   * @param {number|string} level - Log level (number or name)
   */
  setLogLevel(level) {
    if (typeof level === 'string') {
      this.logLevel = CONFIG.LOG_LEVELS[level.toUpperCase()] ?? CONFIG.LOG_LEVELS.INFO;
    } else {
      this.logLevel = level;
    }
    console.log('[Diagnostics] Log level set to:', this._getLevelName(this.logLevel));
  }

  /**
   * Get log level name
   * @private
   */
  _getLevelName(level) {
    const entry = Object.entries(CONFIG.LOG_LEVELS).find(([_, v]) => v === level);
    return entry ? entry[0] : 'UNKNOWN';
  }

  /**
   * Log error message
   * @param {...any} args - Log arguments
   */
  error(...args) {
    if (this.logLevel >= CONFIG.LOG_LEVELS.ERROR) {
      console.error('[ERROR]', ...args);
    }
  }

  /**
   * Log warning message
   * @param {...any} args - Log arguments
   */
  warn(...args) {
    if (this.logLevel >= CONFIG.LOG_LEVELS.WARN) {
      console.warn('[WARN]', ...args);
    }
  }

  /**
   * Log info message
   * @param {...any} args - Log arguments
   */
  info(...args) {
    if (this.logLevel >= CONFIG.LOG_LEVELS.INFO) {
      console.log('[INFO]', ...args);
    }
  }

  /**
   * Log debug message
   * @param {...any} args - Log arguments
   */
  debug(...args) {
    if (this.logLevel >= CONFIG.LOG_LEVELS.DEBUG) {
      console.log('[DEBUG]', ...args);
    }
  }

  /**
   * Log trace message
   * @param {...any} args - Log arguments
   */
  trace(...args) {
    if (this.logLevel >= CONFIG.LOG_LEVELS.TRACE) {
      console.log('[TRACE]', ...args);
      console.trace();
    }
  }

  /**
   * Start performance measurement
   * @param {string} name - Measurement name
   */
  start(name) {
    try {
      if (performance.mark) {
        performance.mark(`${name}-start`);
        this.performanceMarks.add(name);
      } else {
        this.measurements.set(name, performance.now());
      }
    } catch (error) {
      this.error('[Diagnostics] start failed:', error);
    }
  }

  /**
   * End performance measurement
   * @param {string} name - Measurement name
   * @returns {number} Duration in milliseconds
   */
  end(name) {
    try {
      if (performance.mark && performance.measure && this.performanceMarks.has(name)) {
        performance.mark(`${name}-end`);
        const measure = performance.measure(name, `${name}-start`, `${name}-end`);
        this.performanceMarks.delete(name);

        // Clean up marks
        performance.clearMarks(`${name}-start`);
        performance.clearMarks(`${name}-end`);
        performance.clearMeasures(name);

        const duration = measure.duration;
        this.debug(`[Perf] ${name}: ${duration.toFixed(2)}ms`);
        return duration;
      } else if (this.measurements.has(name)) {
        const start = this.measurements.get(name);
        const duration = performance.now() - start;
        this.measurements.delete(name);
        this.debug(`[Perf] ${name}: ${duration.toFixed(2)}ms`);
        return duration;
      } else {
        this.warn('[Diagnostics] No measurement started for:', name);
        return 0;
      }
    } catch (error) {
      this.error('[Diagnostics] end failed:', error);
      return 0;
    }
  }

  /**
   * Measure function execution time
   * @param {string} name - Measurement name
   * @param {Function} fn - Function to measure
   * @returns {*} Function result
   */
  measure(name, fn) {
    this.start(name);
    try {
      const result = fn();
      return result;
    } finally {
      this.end(name);
    }
  }

  /**
   * Measure async function execution time
   * @param {string} name - Measurement name
   * @param {Function} fn - Async function to measure
   * @returns {Promise<*>} Function result
   */
  async measureAsync(name, fn) {
    this.start(name);
    try {
      const result = await fn();
      return result;
    } finally {
      this.end(name);
    }
  }

  /**
   * Track FPS
   * Updates FPS history with current frame time
   * @returns {number} Current FPS
   */
  trackFPS() {
    try {
      const now = performance.now();

      if (this.lastFrameTime !== null) {
        const deltaTime = now - this.lastFrameTime;
        const fps = 1000 / deltaTime;

        this.fpsHistory.push(fps);
        if (this.fpsHistory.length > CONFIG.FPS_SAMPLE_SIZE) {
          this.fpsHistory.shift();
        }
      }

      this.lastFrameTime = now;

      return this.getAverageFPS();
    } catch (error) {
      this.error('[Diagnostics] trackFPS failed:', error);
      return 0;
    }
  }

  /**
   * Get average FPS from history
   * @returns {number} Average FPS
   */
  getAverageFPS() {
    if (this.fpsHistory.length === 0) return 0;

    const sum = this.fpsHistory.reduce((a, b) => a + b, 0);
    return sum / this.fpsHistory.length;
  }

  /**
   * Get FPS statistics
   * @returns {Object} FPS statistics
   */
  getFPSStats() {
    if (this.fpsHistory.length === 0) {
      return { min: 0, max: 0, avg: 0, current: 0 };
    }

    const min = Math.min(...this.fpsHistory);
    const max = Math.max(...this.fpsHistory);
    const avg = this.getAverageFPS();
    const current = this.fpsHistory[this.fpsHistory.length - 1] || 0;

    return { min, max, avg, current };
  }

  /**
   * Get memory usage (if available)
   * @returns {Object} Memory usage object
   */
  getMemoryUsage() {
    try {
      if (performance.memory) {
        return {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        };
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get performance timing information
   * @returns {Object} Performance timing
   */
  getPerformanceTiming() {
    try {
      if (!performance.timing) return null;

      const timing = performance.timing;
      return {
        loadTime: timing.loadEventEnd - timing.navigationStart,
        domReadyTime: timing.domContentLoadedEventEnd - timing.navigationStart,
        dnsTime: timing.domainLookupEnd - timing.domainLookupStart,
        tcpTime: timing.connectEnd - timing.connectStart,
        requestTime: timing.responseEnd - timing.requestStart,
        domInteractive: timing.domInteractive - timing.navigationStart,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Detect browser features
   * @returns {Object} Feature detection results
   */
  detectFeatures() {
    const features = {};

    try {
      // Storage APIs
      features.localStorage = typeof localStorage !== 'undefined';
      features.sessionStorage = typeof sessionStorage !== 'undefined';
      features.indexedDB = typeof indexedDB !== 'undefined';

      // Performance APIs
      features.performanceNow = typeof performance !== 'undefined' && typeof performance.now === 'function';
      features.performanceObserver = typeof PerformanceObserver !== 'undefined';
      features.performanceMemory = typeof performance !== 'undefined' && !!performance.memory;

      // Web APIs
      features.webWorker = typeof Worker !== 'undefined';
      features.serviceWorker = 'serviceWorker' in navigator;
      features.webGL = this._detectWebGL();
      features.webGL2 = this._detectWebGL2();
      features.webAssembly = typeof WebAssembly !== 'undefined';

      // Media APIs
      features.getUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
      features.audioContext = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';

      // Clipboard API
      features.clipboard = !!(navigator.clipboard && navigator.clipboard.writeText);

      // Notification API
      features.notifications = 'Notification' in window;

      // Intersection Observer
      features.intersectionObserver = typeof IntersectionObserver !== 'undefined';
      features.resizeObserver = typeof ResizeObserver !== 'undefined';
      features.mutationObserver = typeof MutationObserver !== 'undefined';

    } catch (error) {
      this.error('[Diagnostics] detectFeatures failed:', error);
    }

    return freeze(features);
  }

  /**
   * Detect WebGL support
   * @private
   */
  _detectWebGL() {
    try {
      const canvas = document.createElement('canvas');
      return !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
    } catch (error) {
      return false;
    }
  }

  /**
   * Detect WebGL2 support
   * @private
   */
  _detectWebGL2() {
    try {
      const canvas = document.createElement('canvas');
      return !!canvas.getContext('webgl2');
    } catch (error) {
      return false;
    }
  }

  /**
   * Log system information
   */
  logSystemInfo() {
    try {
      const info = {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        cookiesEnabled: navigator.cookieEnabled,
        onLine: navigator.onLine,
        screenWidth: screen.width,
        screenHeight: screen.height,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      };

      this.info('[System Info]', info);
      return info;
    } catch (error) {
      this.error('[Diagnostics] logSystemInfo failed:', error);
      return {};
    }
  }

  /**
   * Create performance snapshot
   * @returns {Object} Performance snapshot
   */
  snapshot() {
    return {
      timestamp: Date.now(),
      fps: this.getFPSStats(),
      memory: this.getMemoryUsage(),
      timing: this.getPerformanceTiming(),
    };
  }

  /**
   * Clear all measurements and history
   */
  clear() {
    this.measurements.clear();
    this.fpsHistory = [];
    this.lastFrameTime = null;
    this.performanceMarks.clear();
    this.info('[Diagnostics] Cleared all measurements');
  }
}

// Create singleton instance
const diagnostics = new Diagnostics();

// Freeze and export
const DiagnosticsUtils = freeze({
  // Log methods
  error: (...args) => diagnostics.error(...args),
  warn: (...args) => diagnostics.warn(...args),
  info: (...args) => diagnostics.info(...args),
  debug: (...args) => diagnostics.debug(...args),
  trace: (...args) => diagnostics.trace(...args),

  // Configuration
  setLogLevel: (level) => diagnostics.setLogLevel(level),

  // Performance measurement
  start: (name) => diagnostics.start(name),
  end: (name) => diagnostics.end(name),
  measure: (name, fn) => diagnostics.measure(name, fn),
  measureAsync: (name, fn) => diagnostics.measureAsync(name, fn),

  // FPS tracking
  trackFPS: () => diagnostics.trackFPS(),
  getAverageFPS: () => diagnostics.getAverageFPS(),
  getFPSStats: () => diagnostics.getFPSStats(),

  // System info
  getMemoryUsage: () => diagnostics.getMemoryUsage(),
  getPerformanceTiming: () => diagnostics.getPerformanceTiming(),
  detectFeatures: () => diagnostics.detectFeatures(),
  logSystemInfo: () => diagnostics.logSystemInfo(),

  // Utilities
  snapshot: () => diagnostics.snapshot(),
  clear: () => diagnostics.clear(),
});

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DiagnosticsUtils;
}

if (typeof window !== 'undefined') {
  window.DiagnosticsUtils = DiagnosticsUtils;
  console.log('📦 DiagnosticsUtils loaded');
}

