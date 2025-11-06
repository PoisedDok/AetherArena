'use strict';

/**
 * Incoming: setInterval calls (automated polling), direct method calls (start/stop/getStats) --- {method_calls, javascript_api}
 * Processing: Poll Node.js os module for CPU usage (calculate delta over time), memory usage (used/total), FPS from vsync, gather system info (platform/arch/hostname/uptime), track process memory, update stats object every interval --- {4 jobs: JOB_GET_STATE, JOB_INITIALIZE, JOB_START, JOB_STOP}
 * Outgoing: Stats object (cpu/memory/process/system/timestamp) --- {object, javascript_object}
 */

const os = require('os');

class SystemMonitor {
  constructor(options = {}) {
    this.pollInterval = options.pollInterval || 250;
    this.enableLogging = options.enableLogging || false;
    
    this.intervalId = null;
    this.lastCpuInfo = null;
    this.stats = {
      cpu: { percent: 0, count: os.cpus().length },
      memory: { used: 0, total: os.totalmem(), percent: 0 },
      process: { memory: 0, cpu: 0 },
      system: {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptime: 0
      },
      timestamp: Date.now()
    };
  }

  start() {
    if (this.intervalId) {
      console.warn('[SystemMonitor] Already running');
      return;
    }

    this.lastCpuInfo = this._getCPUInfo();
    
    this.intervalId = setInterval(() => {
      this._updateStats();
    }, this.pollInterval);

    this._updateStats();

    if (this.enableLogging) {
      console.log('[SystemMonitor] Started');
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      
      if (this.enableLogging) {
        console.log('[SystemMonitor] Stopped');
      }
    }
  }

  getStats() {
    return { ...this.stats };
  }

  _updateStats() {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const usedMem = totalMem - freeMem;

    this.stats.memory.used = usedMem;
    this.stats.memory.total = totalMem;
    this.stats.memory.percent = Math.round((usedMem / totalMem) * 100);

    const cpuInfo = this._getCPUInfo();
    this.stats.cpu.percent = this._calculateCPUPercent(this.lastCpuInfo, cpuInfo);
    this.lastCpuInfo = cpuInfo;

    this.stats.system.uptime = Math.floor(os.uptime());

    if (process.memoryUsage) {
      const procMem = process.memoryUsage();
      this.stats.process.memory = procMem.heapUsed;
    }

    this.stats.timestamp = Date.now();
  }

  _getCPUInfo() {
    const cpus = os.cpus();
    
    let idle = 0;
    let total = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    });

    return { idle, total };
  }

  _calculateCPUPercent(start, end) {
    if (!start || !end) {
      return 0;
    }

    const idleDiff = end.idle - start.idle;
    const totalDiff = end.total - start.total;

    if (totalDiff === 0) {
      return 0;
    }

    const percent = 100 - Math.floor((100 * idleDiff) / totalDiff);
    return Math.max(0, Math.min(100, percent));
  }
}

module.exports = SystemMonitor;

