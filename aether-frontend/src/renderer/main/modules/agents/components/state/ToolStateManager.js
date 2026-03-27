/**
 * @.architecture
 * Incoming: AgentsModal, Tool components, endpoint API --- {tool invocations, job fetches}
 * Processing: Manage tool jobs, run state, research status --- {JOB_PREFETCH_JOBS, JOB_TRACK_RUNS}
 * Outgoing: Tool state getters, run status --- {jobs Map, runState Map, researchStatus}
 * 
 * ToolStateManager - Centralized State Management for Tool Execution
 * 
 * Responsibilities:
  // tool-state-manager.test.js or ToolStateManager.js
 * - Prefetch and cache tool jobs (research, etc)
 * - Track tool run state (running, completed, failed)
 * - Manage research service status
 * - Provide query methods for tool data
 * 
 * Extracted from AgentsModal.js lines 178-208, 811-830
 */

'use strict';

class ToolStateManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
    
    // Tool jobs cache: Map<toolName, Array<job>>
    this._toolJobs = new Map();
    
    // Tool run state: Map<toolName, {status, timestamp, time_ms, results, etc}>
    this._toolRunState = new Map();
    
    // Research service status (Perplexica/Searxng availability)
    this._researchStatus = null;
  }

  /**
   * Prefetch jobs for all specified tools
   * @param {Object} endpoint - API endpoint instance
   * @param {Array<string>} toolNames - Array of tool names to fetch jobs for
   * @param {Function} findAgentFn - Function to find agent by name
   * @returns {Promise<void>}
   */
  async prefetchJobs(endpoint, toolNames, findAgentFn) {
    if (!endpoint) {
      this.logger.warn('ToolStateManager: Endpoint not available, skipping job prefetch');
      return;
    }

    if (!Array.isArray(toolNames) || toolNames.length === 0) {
      this.logger.warn('ToolStateManager: No tool names provided for job prefetch');
      return;
    }

    await Promise.all(toolNames.map(async (agentName) => {
      const agent = findAgentFn ? findAgentFn(agentName) : null;
      if (!agent) {
        this._toolJobs.set(agentName, []);
        return;
      }

      try {
        const response = await endpoint.listAgentHistory({ 
          agentName, 
          limit: 10 // Fetch slightly more to account for deduplication
        });
        
        let rawJobs = response?.history || response?.jobs || response || [];
        if (!Array.isArray(rawJobs)) rawJobs = [];

        // Deduplicate jobs by ID, keeping the most advanced status
        // Priority: completed > failed > running > processing > queued > pending
        const statusPriority = {
          'completed': 5,
          'failed': 4,
          'running': 3,
          'processing': 2,
          'queued': 1,
          'pending': 0
        };

        const dedupedMap = new Map();
        rawJobs.forEach(job => {
          const id = job.id || job.job_id;
          if (!id) return;

          const existing = dedupedMap.get(id);
          const currentStatus = String(job.status || '').toLowerCase();
          const currentPriority = statusPriority[currentStatus] ?? -1;

          if (!existing) {
            dedupedMap.set(id, job);
          } else {
            const existingStatus = String(existing.status || '').toLowerCase();
            const existingPriority = statusPriority[existingStatus] ?? -1;
            
            if (currentPriority > existingPriority) {
              dedupedMap.set(id, job);
            }
          }
        });

        const jobs = Array.from(dedupedMap.values())
          .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
          .slice(0, 5); // Keep only top 5 unique jobs

        this._toolJobs.set(agentName, jobs);
        
        // Sync runState with the most recent job if it's active
        if (jobs.length > 0) {
          const latestJob = jobs[0];
          const status = String(latestJob.status || '').toLowerCase();
          const isActive = ['pending', 'running', 'processing', 'queued'].includes(status);
          
          if (isActive) {
            this.recordToolRun(agentName, {
              status: status,
              job_id: latestJob.id || latestJob.job_id,
              created_at: latestJob.created_at
            });
          } else if (status === 'completed' || status === 'failed') {
             // Optional: sync last finished job too if we don't have a more recent local run
             const current = this.getToolRunState(agentName);
             if (!current || new Date(latestJob.created_at) > new Date(current.timestamp)) {
               this.recordToolRun(agentName, {
                 status: status,
                 job_id: latestJob.id || latestJob.job_id,
                 time_ms: latestJob.time_ms || latestJob.metadata?.time_ms,
                 timestamp: latestJob.created_at
               });
             }
          }
        }
        
        this.logger.info(`ToolStateManager: Prefetched ${jobs.length} items for ${agentName}`);
      } catch (error) {
        this.logger.warn('ToolStateManager: Failed to prefetch tool jobs', { 
          agentName, 
          error: error?.message || error 
        });
        this._toolJobs.set(agentName, []);
      }
    }));
  }

  /**
   * Prefetch research service status
   * @param {Object} endpoint - API endpoint instance
   * @returns {Promise<void>}
   */
  async prefetchResearchStatus(endpoint) {
    if (!endpoint) {
      this.logger.warn('ToolStateManager: Endpoint not available, skipping research status');
      return;
    }

    try {
      this._researchStatus = await endpoint.getResearchStatus();
      this.logger.info('ToolStateManager: Prefetched research status');
    } catch (error) {
      // Fail-soft: show status unavailable; invocation will fail-fast when user runs it.
      this._researchStatus = null;
      this.logger.warn('ToolStateManager: Failed to prefetch research status', { 
        error: error?.message || error 
      });
    }
  }

  /**
   * Prefetch all tool-related data (convenience method)
   * @param {Object} endpoint - API endpoint instance
   * @param {Array<string>} toolNames - Array of tool names
   * @param {Function} findAgentFn - Function to find agent by name
   * @returns {Promise<void>}
   */
  async prefetchAll(endpoint, toolNames, findAgentFn) {
    await Promise.all([
      this.prefetchJobs(endpoint, toolNames, findAgentFn),
      this.prefetchResearchStatus(endpoint)
    ]);
  }

  /**
   * Get jobs for a specific tool
   * @param {string} toolName - Tool name
   * @returns {Array} Array of job objects
   */
  getToolJobs(toolName) {
    return this._toolJobs.get(toolName) || [];
  }

  /**
   * Set jobs for a specific tool
   * @param {string} toolName - Tool name
   * @param {Array} jobs - Array of job objects
   */
  setToolJobs(toolName, jobs) {
    if (!toolName) return;
    this._toolJobs.set(toolName, jobs || []);
  }

  /**
   * Get run state for a specific tool
   * @param {string} toolName - Tool name
   * @returns {Object|null} Run state object or null
   */
  getToolRunState(toolName) {
    return this._toolRunState.get(toolName) || null;
  }

  /**
   * Record tool run state
   * @param {string} toolName - Tool name
   * @param {Object} payload - Run state payload
   * @param {string} payload.status - Run status (running|completed|failed)
   * @param {number} [payload.time_ms] - Execution time in milliseconds
   * @param {number} [payload.sources_used] - Number of sources used
   * @param {Object} [payload.results] - Results object
   * @param {string} [payload.output_id] - Output ID for persistence
   * @param {string} [payload.entity_id] - Entity ID
   * @returns {Object} The recorded entry
   */
  recordToolRun(toolName, payload) {
    if (!toolName) {
      this.logger.warn('ToolStateManager: Cannot record tool run without toolName');
      return null;
    }

    const entry = {
      ...payload,
      timestamp: payload.timestamp || new Date().toISOString()
    };

    this._toolRunState.set(toolName, entry);
    this.logger.info(`ToolStateManager: Recorded run for ${toolName}`, { 
      status: entry.status 
    });

    return entry;
  }

  /**
   * Mark tool as running (convenience method)
   * @param {string} toolName - Tool name
   */
  markToolRunning(toolName) {
    if (!toolName) return;
    this.recordToolRun(toolName, {
      status: 'running',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Mark tool as completed
   * @param {string} toolName - Tool name
   * @param {Object} result - Result data
   */
  markToolCompleted(toolName, result = {}) {
    if (!toolName) return;
    this.recordToolRun(toolName, {
      status: 'completed',
      ...result
    });
  }

  /**
   * Mark tool as failed
   * @param {string} toolName - Tool name
   * @param {Error|string} error - Error object or message
   */
  markToolFailed(toolName, error) {
    if (!toolName) return;
    this.recordToolRun(toolName, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    });
  }

  /**
   * Get research service status
   * @returns {Object|null} Research status object or null
   */
  getResearchStatus() {
    return this._researchStatus;
  }

  /**
   * Set research service status
   * @param {Object} status - Research status object
   */
  setResearchStatus(status) {
    this._researchStatus = status;
  }

  /**
   * Clear run state for a specific tool
   * @param {string} toolName - Tool name
   */
  clearToolRunState(toolName) {
    if (!toolName) return;
    this._toolRunState.delete(toolName);
  }

  /**
   * Clear all run states
   */
  clearAllRunStates() {
    this._toolRunState.clear();
  }

  /**
   * Reset all state
   */
  reset() {
    this._toolJobs.clear();
    this._toolRunState.clear();
    this._researchStatus = null;
  }

  /**
   * Get all tool names with cached jobs
   * @returns {Array<string>}
   */
  getToolNamesWithJobs() {
    return Array.from(this._toolJobs.keys());
  }

  /**
   * Get all tool names with run state
   * @returns {Array<string>}
   */
  getToolNamesWithRunState() {
    return Array.from(this._toolRunState.keys());
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ToolStateManager;
}

// Global registration
if (typeof window !== 'undefined') {
  window.ToolStateManager = ToolStateManager;
}
