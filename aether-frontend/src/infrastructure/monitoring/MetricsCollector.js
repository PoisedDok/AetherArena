'use strict';

/**
 * @.architecture
 * 
 * Incoming: Constructor options, direct method calls (recordFPS/recordLatency/recordMemory/recordTokens/recordCustom), requestAnimationFrame callbacks, setInterval callbacks --- {method_calls | browser_event, object | number}
 * Processing: Initialize metrics storage (fps/latency/memory/requests/tokens/custom), track FPS via requestAnimationFrame, track latency via ping Map, query performance.memory API, track requests (start/success/error counters), track tokens (input/output/total), track custom metrics, calculate statistics (avg/min/max), trim history arrays (maxHistorySize=1000), generate snapshots (strip history), optional backend reporting (POST /monitoring), reset metrics --- {11 jobs: JOB_GET_STATE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_INITIALIZE, JOB_START, JOB_STOP, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_UPDATE_STATE}
 * Outgoing: Backend /monitoring endpoint (optional, fetch POST), return values from getters (getSnapshot/getFPSStats/getLatencyStats/getMemoryStats/getRequestStats/getTokenStats/getCustom), window.MetricsCollector global --- {http_request | object | class_reference, json | javascript_object | global}
 * 
 * 
 * @module infrastructure/monitoring/MetricsCollector
 * 
 * MetricsCollector - Application metrics collection
 * ============================================================================
 * Production-grade metrics collection for frontend monitoring:
 * - FPS (frames per second)
 * - Latency (network round-trip time)
 * - Memory usage
 * - Request counts
 * - Token usage
 * - Custom metrics
 * 
 * Metrics are collected locally and optionally reported to backend /monitoring endpoint.
 */

const { freeze } = Object;

class MetricsCollector {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.reportInterval = options.reportInterval || 30000; // 30 seconds
    this.maxHistorySize = options.maxHistorySize || 1000;
    this.reportToBackend = options.reportToBackend || false;
    this.backendURL = options.backendURL || null;
    
    // Metrics storage
    this.metrics = {
      fps: { current: 0, avg: 0, min: Infinity, max: 0, history: [] },
      latency: { current: 0, avg: 0, min: Infinity, max: 0, history: [] },
      memory: { used: 0, total: 0, limit: 0, history: [] },
      requests: { total: 0, success: 0, error: 0, pending: 0 },
      tokens: { total: 0, input: 0, output: 0 },
      custom: {}
    };
    
    // FPS tracking
    this.fpsFrameTimes = [];
    this.lastFrameTime = null;
    this.fpsRequestId = null;
    
    // Latency tracking
    this.latencyPings = new Map();
    
    // Report timer
    this.reportTimer = null;
    
    // Start collecting
    if (typeof window !== 'undefined') {
      this.start();
    }
  }

  /**
   * Start metrics collection
   */
  start() {
    if (this.enableLogging) {
      console.log('[MetricsCollector] Started');
    }
    
    // Start FPS tracking
    this._startFPSTracking();
    
    // Start periodic reporting
    if (this.reportToBackend && this.backendURL) {
      this._startReporting();
    }
  }

  /**
   * Stop metrics collection
   */
  stop() {
    if (this.fpsRequestId) {
      cancelAnimationFrame(this.fpsRequestId);
      this.fpsRequestId = null;
    }
    
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    
    if (this.enableLogging) {
      console.log('[MetricsCollector] Stopped');
    }
  }

  // ==========================================================================
  // FPS Metrics
  // ==========================================================================

  /**
   * Record FPS measurement
   * @param {number} fps - Frames per second
   */
  recordFPS(fps) {
    if (!Number.isFinite(fps) || fps < 0) return;
    
    const m = this.metrics.fps;
    m.current = fps;
    m.min = Math.min(m.min, fps);
    m.max = Math.max(m.max, fps);
    m.history.push({ value: fps, timestamp: Date.now() });
    
    // Trim history
    if (m.history.length > this.maxHistorySize) {
      m.history.shift();
    }
    
    // Calculate average
    m.avg = m.history.reduce((sum, item) => sum + item.value, 0) / m.history.length;
  }

  /**
   * Get FPS statistics
   * @returns {Object}
   */
  getFPSStats() {
    return freeze({ ...this.metrics.fps });
  }

  // ==========================================================================
  // Latency Metrics
  // ==========================================================================

  /**
   * Start latency ping
   * @param {string} id - Ping identifier
   * @returns {string} Ping ID
   */
  startLatencyPing(id = null) {
    if (!id) {
      id = `ping_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    this.latencyPings.set(id, Date.now());
    return id;
  }

  /**
   * End latency ping
   * @param {string} id - Ping identifier
   * @returns {number|null} Latency in milliseconds
   */
  endLatencyPing(id) {
    const startTime = this.latencyPings.get(id);
    if (!startTime) return null;
    
    const latency = Date.now() - startTime;
    this.latencyPings.delete(id);
    
    this.recordLatency(latency);
    return latency;
  }

  /**
   * Record latency measurement
   * @param {number} latency - Latency in milliseconds
   */
  recordLatency(latency) {
    if (!Number.isFinite(latency) || latency < 0) return;
    
    const m = this.metrics.latency;
    m.current = latency;
    m.min = Math.min(m.min, latency);
    m.max = Math.max(m.max, latency);
    m.history.push({ value: latency, timestamp: Date.now() });
    
    // Trim history
    if (m.history.length > this.maxHistorySize) {
      m.history.shift();
    }
    
    // Calculate average
    m.avg = m.history.reduce((sum, item) => sum + item.value, 0) / m.history.length;
  }

  /**
   * Get latency statistics
   * @returns {Object}
   */
  getLatencyStats() {
    return freeze({ ...this.metrics.latency });
  }

  // ==========================================================================
  // Memory Metrics
  // ==========================================================================

  /**
   * Record memory usage
   */
  recordMemory() {
    if (typeof performance === 'undefined' || !performance.memory) {
      return;
    }
    
    const m = this.metrics.memory;
    m.used = performance.memory.usedJSHeapSize;
    m.total = performance.memory.totalJSHeapSize;
    m.limit = performance.memory.jsHeapSizeLimit;
    
    m.history.push({
      used: m.used,
      total: m.total,
      timestamp: Date.now()
    });
    
    // Trim history
    if (m.history.length > this.maxHistorySize) {
      m.history.shift();
    }
  }

  /**
   * Get memory statistics
   * @returns {Object}
   */
  getMemoryStats() {
    this.recordMemory();
    return freeze({ ...this.metrics.memory });
  }

  // ==========================================================================
  // Request Metrics
  // ==========================================================================

  /**
   * Record request start
   */
  recordRequestStart() {
    this.metrics.requests.pending++;
    this.metrics.requests.total++;
  }

  /**
   * Record request success
   */
  recordRequestSuccess() {
    this.metrics.requests.pending--;
    this.metrics.requests.success++;
  }

  /**
   * Record request error
   */
  recordRequestError() {
    this.metrics.requests.pending--;
    this.metrics.requests.error++;
  }

  /**
   * Get request statistics
   * @returns {Object}
   */
  getRequestStats() {
    return freeze({ ...this.metrics.requests });
  }

  // ==========================================================================
  // Token Metrics
  // ==========================================================================

  /**
   * Record token usage
   * @param {number} inputTokens - Input tokens
   * @param {number} outputTokens - Output tokens
   */
  recordTokens(inputTokens = 0, outputTokens = 0) {
    this.metrics.tokens.input += inputTokens;
    this.metrics.tokens.output += outputTokens;
    this.metrics.tokens.total += inputTokens + outputTokens;
  }

  /**
   * Get token statistics
   * @returns {Object}
   */
  getTokenStats() {
    return freeze({ ...this.metrics.tokens });
  }

  // ==========================================================================
  // Custom Metrics
  // ==========================================================================

  /**
   * Record custom metric
   * @param {string} name - Metric name
   * @param {number} value - Metric value
   */
  recordCustom(name, value) {
    if (!this.metrics.custom[name]) {
      this.metrics.custom[name] = {
        current: 0,
        total: 0,
        count: 0,
        avg: 0,
        min: Infinity,
        max: 0
      };
    }
    
    const m = this.metrics.custom[name];
    m.current = value;
    m.total += value;
    m.count++;
    m.avg = m.total / m.count;
    m.min = Math.min(m.min, value);
    m.max = Math.max(m.max, value);
  }

  /**
   * Get custom metric
   * @param {string} name - Metric name
   * @returns {Object|null}
   */
  getCustom(name) {
    return this.metrics.custom[name] ? freeze({ ...this.metrics.custom[name] }) : null;
  }

  // ==========================================================================
  // Snapshot & Reporting
  // ==========================================================================

  /**
   * Get complete metrics snapshot
   * @returns {Object}
   */
  getSnapshot() {
    this.recordMemory();
    
    return freeze({
      timestamp: Date.now(),
      fps: { ...this.metrics.fps, history: undefined },
      latency: { ...this.metrics.latency, history: undefined },
      memory: { ...this.metrics.memory, history: undefined },
      requests: { ...this.metrics.requests },
      tokens: { ...this.metrics.tokens },
      custom: { ...this.metrics.custom }
    });
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.metrics = {
      fps: { current: 0, avg: 0, min: Infinity, max: 0, history: [] },
      latency: { current: 0, avg: 0, min: Infinity, max: 0, history: [] },
      memory: { used: 0, total: 0, limit: 0, history: [] },
      requests: { total: 0, success: 0, error: 0, pending: 0 },
      tokens: { total: 0, input: 0, output: 0 },
      custom: {}
    };
    
    if (this.enableLogging) {
      console.log('[MetricsCollector] Reset');
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Start FPS tracking
   * @private
   */
  _startFPSTracking() {
    const track = (timestamp) => {
      if (this.lastFrameTime !== null) {
        const delta = timestamp - this.lastFrameTime;
        const fps = delta > 0 ? Math.round(1000 / delta) : 0;
        this.recordFPS(fps);
      }
      
      this.lastFrameTime = timestamp;
      this.fpsRequestId = requestAnimationFrame(track);
    };
    
    this.fpsRequestId = requestAnimationFrame(track);
  }

  /**
   * Start periodic reporting
   * @private
   */
  _startReporting() {
    this.reportTimer = setInterval(() => {
      this._reportToBackend();
    }, this.reportInterval);
  }

  /**
   * Report metrics to backend
   * @private
   */
  async _reportToBackend() {
    if (!this.backendURL) return;
    
    try {
      const snapshot = this.getSnapshot();
      
      await fetch(`${this.backendURL}/monitoring`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'frontend',
          metrics: snapshot
        })
      });
      
      if (this.enableLogging) {
        console.log('[MetricsCollector] Reported to backend');
      }
    } catch (error) {
      console.error('[MetricsCollector] Failed to report to backend:', error);
    }
  }
}

// Export
module.exports = { MetricsCollector };

if (typeof window !== 'undefined') {
  window.MetricsCollector = MetricsCollector;
  console.log('📦 MetricsCollector loaded');
}

