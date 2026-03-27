/**
 * @.architecture
 *
 * Incoming: Aether system stats IPC, guru state (audioLevel, assistant, lastPingTime), visualizer FPS/nodes, endpoint health API --- {ipc_types.stats, ws_types.state, api_types.response}
 * Processing: Poll telemetry on 1s interval, poll model indicator on 15s interval, format and render to DOM --- {3 jobs: JOB_POLL, JOB_FORMAT, JOB_RENDER}
 * Outgoing: DOM textContent updates (CPU, memory, FPS, mic, status, latency, nodes, time, model) --- {dom_types.textContent}
 *
 * Extracted from MainApp.js to reduce god-object size.
 */

'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');

class TelemetryController {
  /**
   * @param {Object} options
   * @param {Object} options.aether - Aether bridge (for system stats)
   * @param {Object} options.guru - GuruConnection instance (for state reads)
   * @param {Object} options.visualizer - NeuralNetworkVisualizer instance
   * @param {Object} options.endpoint - Endpoint instance (for health check)
   * @param {Object} options.elements - Telemetry DOM elements
   */
  constructor(options = {}) {
    this.log = createRendererLogger('TelemetryController');
    this.aether = options.aether || null;
    this.guru = options.guru || null;
    this.visualizer = options.visualizer || null;
    this.endpoint = options.endpoint || null;
    this.elements = options.elements || {};

    this._isDisposed = false;
    this._telemetryInterval = null;
    this._systemTimeInterval = null;
    this._modelIndicatorInterval = null;
  }

  /**
   * Start all telemetry polling intervals.
   */
  start() {
    if (this._isDisposed) return;
    this._telemetryInterval = setInterval(() => {
      if (!document.hidden) this.updateTelemetry();
    }, 1000);

    this._systemTimeInterval = setInterval(() => {
      if (!document.hidden) this.updateSystemTime();
    }, 1000);

    this._modelIndicatorInterval = setInterval(() => {
      if (!document.hidden) this.updateModelIndicator();
    }, 15000);

    this.updateTelemetry();
    this.updateSystemTime();
    this.updateModelIndicator();

    this.log.debug('Telemetry updates started');
  }

  // ── Update Methods ─────────────────────────────────────────

  async updateTelemetry() {
    const stats = await this.aether?.system?.getStats?.();

    if (stats) {
      if (this.elements.cpuUsage) {
        this.elements.cpuUsage.textContent = `${stats.cpu.percent}%`;
      }

      if (this.elements.memoryUsage) {
        const memMB = Math.round(stats.process.memory / (1024 * 1024));
        this.elements.memoryUsage.textContent = `${memMB} MB`;
      }
    }

    if (this.elements.fpsCounter && this.visualizer) {
      const fps = this.visualizer.fpsValues.length
        ? Math.round(this.visualizer.fpsValues.reduce((a, b) => a + b) / this.visualizer.fpsValues.length)
        : 60;
      this.elements.fpsCounter.textContent = `${fps}`;
    }

    if (this.elements.systemStatus && this.guru) {
      const status = (this.guru.state.assistant || 'idle').toUpperCase();
      this.elements.systemStatus.textContent = status;

      this.elements.systemStatus.className = 'stat-value status-badge';
      this.elements.systemStatus.classList.add(`status-${this.guru.state.assistant || 'idle'}`);
    }

    if (this.elements.micPercentage && this.guru) {
      const level = this.guru.state.audioLevel;
      const pct = Math.round((level || 0) * 100);
      this.elements.micPercentage.textContent = `${pct}%`;
    }

    if (this.elements.networkLatency && this.guru && this.guru.lastPingTime !== undefined) {
      this.elements.networkLatency.textContent = `${this.guru.lastPingTime}ms`;
    }

    if (this.elements.nodeCount && this.visualizer && this.visualizer.neuralNetwork) {
      const nodeCount = this.visualizer.neuralNetwork.nodes?.length || 0;
      this.elements.nodeCount.textContent = `${nodeCount}`;
    }
  }

  updateSystemTime() {
    if (this.elements.systemTime) {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      this.elements.systemTime.textContent = `${hours}:${minutes}:${seconds}`;
    }
  }

  async updateModelIndicator() {
    try {
      const endpoint = this.endpoint;
      if (!endpoint) {
        this.setModelStatus('offline', 'No Connection');
        return;
      }

      const health = await endpoint.getHealth();

      if (health && health.model) {
        this.setModelStatus('online', health.model);
      } else if (health && health.status === 'ok') {
        this.setModelStatus('online', 'Connected');
      } else {
        this.setModelStatus('offline', 'Unavailable');
      }
    } catch (error) {
      this.setModelStatus('offline', 'Offline');
    }
  }

  setModelStatus(status, modelName) {
    if (this.elements.modelStatusDot) {
      this.elements.modelStatusDot.className = 'model-status-dot';
      this.elements.modelStatusDot.classList.add(status);
    }

    if (this.elements.modelName && modelName) {
      const displayName = this._formatModelName(modelName);
      this.elements.modelName.textContent = displayName;
      // Full model ID as tooltip for space-constrained stats bar
      this.elements.modelName.title = modelName;
    }
  }

  /**
   * Format a raw model ID for concise stats-bar display.
   * "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit" -> "Qwen3-4b-Instruct-2507-MLX-8bit"
   * @private
   */
  _formatModelName(raw) {
    if (!raw) return raw;
    const parts = raw.split('/');
    let name = parts.length > 1 ? parts[parts.length - 1] : raw;
    if (name.length > 28) {
      name = name.slice(0, 25) + '...';
    }
    return name;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  stop() {
    if (this._telemetryInterval) {
      clearInterval(this._telemetryInterval);
      this._telemetryInterval = null;
    }
    if (this._systemTimeInterval) {
      clearInterval(this._systemTimeInterval);
      this._systemTimeInterval = null;
    }
    if (this._modelIndicatorInterval) {
      clearInterval(this._modelIndicatorInterval);
      this._modelIndicatorInterval = null;
    }
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.stop();
    this.aether = null;
    this.guru = null;
    this.visualizer = null;
    this.endpoint = null;
    this.elements = {};
  }
}

module.exports = TelemetryController;
