'use strict';

// Incoming: Trail/node lifecycle events from Orchestrator --- {start, complete events}
// Processing: Time tracking, periodic updates, elapsed calculations --- {2 jobs: JOB_TRACK_TIME, JOB_UPDATE_DOM}
// Outgoing: DOM time updates --- {formatted time strings}

const { createRendererLogger } = require('../../../shared/utils/logger');

const timeLogger = createRendererLogger('TrailTimeManager');

/**
 * TrailTimeManager - Time Tracking and Live Updates
 * ==================================================
 * 
 * SINGLE RESPONSIBILITY: Manage all time-related operations
 * 
 * TIME TRACKING:
 * - Trail start/end times
 * - Node start/end times
 * - Periodic live updates (1s interval)
 * 
 * CONTRACTS:
 * - Receives lifecycle events (start/complete)
 * - Updates DOM time displays directly
 * - Manages intervals for active trails/nodes
 * - FAIL FAST on contract violations
 * 
 * @module renderer/chat/modules/trail/TrailTimeManager
 */
class TrailTimeManager {
  constructor(options = {}) {
    this.container = options.container || null;
    this.log = timeLogger.child({ scope: 'trail-time-manager' });
    
    // Time tracking maps
    this.trailTimes = new Map(); // trailId → { startTime, endTime, intervalId }
    this.nodeTimes = new Map();  // nodeId → { startTime, endTime }
    this._isDisposed = false;
    
    this.log.info('TrailTimeManager initialized');
  }
  
  // =========================================================================
  // TRAIL TIME MANAGEMENT
  // =========================================================================
  
  /**
   * Start tracking trail time
   * @param {string} trailId - Trail identifier (from dataset.trailId)
   * @param {number} startTime - Start timestamp (ms)
   */
  startTrail(trailId, startTime) {
    if (!trailId) {
      throw new Error('[TrailTimeManager] startTrail: trailId is REQUIRED');
    }
    
    // Clear existing interval if trail was already started (prevents orphaned intervals)
    const existing = this.trailTimes.get(trailId);
    if (existing && existing.intervalId) {
      clearInterval(existing.intervalId);
    }
    
    // Start time tracking
    this.trailTimes.set(trailId, {
      startTime: startTime || Date.now(),
      endTime: null,
      intervalId: null
    });
    
    // Start periodic update interval (every 1 second)
    const intervalId = setInterval(() => {
      this._updateTrailTimeDisplay(trailId);
    }, 1000);
    
    const trailTime = this.trailTimes.get(trailId);
    trailTime.intervalId = intervalId;
    
    this.log.debug('Started trail time tracking', {
      trailId: trailId.substring(0, 20),
      startTime
    });
  }
  
  /**
   * Complete trail time tracking
   * @param {string} trailId - Trail identifier
   * @param {number} endTime - End timestamp (ms, optional - defaults to now)
   */
  completeTrail(trailId, endTime = null) {
    if (!trailId) {
      throw new Error('[TrailTimeManager] completeTrail: trailId is REQUIRED');
    }
    
    const trailTime = this.trailTimes.get(trailId);
    if (!trailTime) {
      this.log.warn('Trail time not found for completion', { trailId });
      return;
    }
    
    // Stop interval
    if (trailTime.intervalId) {
      clearInterval(trailTime.intervalId);
      trailTime.intervalId = null;
    }
    
    // Set end time
    trailTime.endTime = endTime || Date.now();
    
    // CRITICAL: Also set endTime in dataset for DOMRenderer to read
    if (this.container) {
      const trailElement = this.container.querySelector(`[data-trail-id="${trailId}"]`);
      if (trailElement) {
        trailElement.dataset.endTime = trailTime.endTime.toString();
      }
    }
    
    // Final update
    this._updateTrailTimeDisplay(trailId);
    
    this.log.debug('Completed trail time tracking', {
      trailId: trailId.substring(0, 20),
      elapsed: trailTime.endTime - trailTime.startTime
    });
  }
  
  /**
   * Update trail time display in DOM
   * @private
   * @param {string} trailId - Trail identifier
   */
  _updateTrailTimeDisplay(trailId) {
    if (!this.container) return;
    
    const trailElement = this.container.querySelector(`[data-trail-id="${trailId}"]`);
    if (!trailElement) return;
    
    const trailTime = this.trailTimes.get(trailId);
    if (!trailTime) return;
    
    const elapsed = this._formatElapsed(trailTime.startTime, trailTime.endTime);
    
    // Update .trail-time display
    const timeDisplay = trailElement.querySelector('.trail-time');
    if (timeDisplay) {
      timeDisplay.textContent = elapsed;
    }
    
    // Update collapsed state title if collapsed
    if (trailElement.dataset.state === 'collapsed') {
      const titleText = trailElement.querySelector('.trail-title-text');
      const trailNumber = trailElement.dataset.trailNumber;
      if (titleText && trailNumber) {
        titleText.textContent = `Trail ${trailNumber} (${elapsed})`;
      }
    }
  }
  
  // =========================================================================
  // NODE TIME MANAGEMENT
  // =========================================================================
  
  /**
   * Start tracking node time (when node becomes active)
   * @param {string} nodeId - Node identifier
   * @param {string} subgroupId - Subgroup identifier (for DOM lookup)
   * @param {number} startTime - Start timestamp (ms, optional)
   */
  startNode(nodeId, subgroupId, startTime = null) {
    if (!nodeId || !subgroupId) {
      throw new Error('[TrailTimeManager] startNode: nodeId and subgroupId are REQUIRED');
    }
    
    // Clear existing interval if node was already started (prevents orphaned intervals)
    const existingNode = this.nodeTimes.get(nodeId);
    if (existingNode && existingNode.intervalId) {
      clearInterval(existingNode.intervalId);
    }
    
    // CRITICAL FIX: Start periodic update interval (like trail timer)
    // Nodes need live updates while active, not just initial display
    const intervalId = setInterval(() => {
      this._updateNodeTimeDisplay(nodeId, subgroupId);
    }, 1000); // Update every 1 second
    
    this.nodeTimes.set(nodeId, {
      startTime: startTime || Date.now(),
      endTime: null,
      subgroupId,
      intervalId // Store interval ID for cleanup
    });
    
    // Immediate update
    this._updateNodeTimeDisplay(nodeId, subgroupId);
    
    this.log.debug('Started node time tracking with live updates', {
      nodeId: nodeId.substring(0, 8),
      subgroupId: subgroupId.substring(0, 8)
    });
  }
  
  /**
   * Complete node time tracking (when node completes)
   * @param {string} nodeId - Node identifier
   * @param {string} subgroupId - Subgroup identifier
   * @param {number} endTime - End timestamp (ms, optional)
   */
  completeNode(nodeId, subgroupId, endTime = null) {
    if (!nodeId || !subgroupId) {
      throw new Error('[TrailTimeManager] completeNode: nodeId and subgroupId are REQUIRED');
    }
    
    const nodeTime = this.nodeTimes.get(nodeId);
    if (!nodeTime) {
      // Node might not have been started (e.g., skipped)
      this.log.trace('Node time not found for completion', { nodeId });
      return;
    }
    
    // CRITICAL FIX: Clear the live update interval
    if (nodeTime.intervalId) {
      clearInterval(nodeTime.intervalId);
      nodeTime.intervalId = null;
    }
    
    nodeTime.endTime = endTime || Date.now();
    
    // Final update
    this._updateNodeTimeDisplay(nodeId, subgroupId);
    
    this.log.debug('Completed node time tracking', {
      nodeId: nodeId.substring(0, 8),
      elapsed: nodeTime.endTime - nodeTime.startTime
    });
  }
  
  /**
   * Update node time display in DOM
   * @private
   * @param {string} nodeId - Node identifier
   * @param {string} subgroupId - Subgroup identifier
   */
  _updateNodeTimeDisplay(nodeId, subgroupId) {
    if (!this.container) return;
    
    const nodeElement = this.container.querySelector(
      `[data-subgroup-id="${subgroupId}"][data-node-id="${nodeId}"]`
    );
    
    if (!nodeElement) return;
    
    const nodeTime = this.nodeTimes.get(nodeId);
    if (!nodeTime) return;
    
    const nodeTimeDisplay = nodeElement.querySelector('.node-time');
    if (!nodeTimeDisplay) return;
    
    const elapsed = this._formatElapsed(nodeTime.startTime, nodeTime.endTime);
    nodeTimeDisplay.textContent = elapsed;
  }
  
  // =========================================================================
  // TIME FORMATTING HELPERS
  // =========================================================================
  
  /**
   * Format elapsed time
   * @private
   * @param {number} startTime - Start timestamp (ms)
   * @param {number|null} endTime - End timestamp (ms, null = ongoing)
   * @returns {string} Formatted time (e.g., "5s", "1m 23s")
   */
  _formatElapsed(startTime, endTime) {
    if (!startTime) return '0s';
    
    const elapsed = (endTime || Date.now()) - startTime;
    const seconds = Math.floor(elapsed / 1000);
    
    if (seconds < 60) {
      return `${seconds}s`;
    } else {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds}s`;
    }
  }
  
  // =========================================================================
  // CLEANUP
  // =========================================================================
  
  /**
   * Clear all intervals and time tracking
   */
  destroy() {
    if (this._isDisposed) return;
    
    // Stop all trail intervals
    for (const [trailId, trailTime] of this.trailTimes.entries()) {
      if (trailTime.intervalId) {
        clearInterval(trailTime.intervalId);
      }
    }
    
    // Stop all node intervals
    for (const [nodeId, nodeTime] of this.nodeTimes.entries()) {
      if (nodeTime.intervalId) {
        clearInterval(nodeTime.intervalId);
      }
    }
    
    this.trailTimes.clear();
    this.nodeTimes.clear();
    this.container = null;
    
    this._isDisposed = true;
    this.log.info('TrailTimeManager destroyed');
  }
}

module.exports = TrailTimeManager;
