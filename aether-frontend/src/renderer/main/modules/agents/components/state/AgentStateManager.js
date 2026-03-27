/**
 * @.architecture
 * Incoming: AgentsModal, endpoint API --- {fetch requests, state updates}
 * Processing: Manage agent/model/template/settings state --- {JOB_FETCH_DATA, JOB_TRACK_CHANGES}
 * Outgoing: State getters, dirty tracking --- {agents[], models[], templates}
 * 
 * AgentStateManager - Centralized State Management for Agent Configuration
 * 
 * Responsibilities:
 * - Fetch and store agent configurations
 * - Fetch and store available models
 * - Fetch and store agent templates (defaults/descriptions)
 * - Fetch and store global settings
 * - Track agent selection state
 * - Track dirty (unsaved) agents
 * - Provide query methods for agent data
 * 
 * Extracted from AgentsModal.js lines 125-177, 445-449, 474-492, 897-920
 */

'use strict';

class AgentStateManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
    
    // Core state
    this.agents = [];
    this.models = [];
    this.templatesByName = {};
    this.settings = null;
    
    // UI state
    this.selectedAgent = null; // Index of selected agent in system view
    
    // Change tracking
    this.dirtyAgents = new Set(); // Set of agent names with unsaved changes
  }

  /**
   * Fetch all agent-related data from backend
   * @param {Object} endpoint - API endpoint instance
   * @returns {Promise<void>}
   */
  async fetchAll(endpoint) {
    if (!endpoint) {
      throw new Error('Endpoint is required');
    }

    await Promise.all([
      this._fetchAgents(endpoint),
      this._fetchModels(endpoint),
      this._fetchTemplates(endpoint),
      this._fetchSettings(endpoint)
    ]);
  }

  /**
   * Fetch agent configurations from backend
   * @private
   */
  async _fetchAgents(endpoint) {
    try {
      const response = await endpoint.listAgentConfigs();
      this.agents = response || [];
      this.logger.info(`AgentStateManager: Loaded ${this.agents.length} agent configurations`);
    } catch (error) {
      this.logger.error('AgentStateManager: Failed to fetch agents:', error);
      throw error;
    }
  }

  /**
   * Fetch available models from backend
   * @private
   */
  async _fetchModels(endpoint) {
    try {
      const response = await endpoint.getAgentModels();
      this.models = response?.models || [];
      this.logger.info(`AgentStateManager: Loaded ${this.models.length} models`);
    } catch (error) {
      this.logger.error('AgentStateManager: Failed to fetch agent models:', error);
      throw error;
    }
  }

  /**
   * Fetch agent templates (defaults and descriptions)
   * @private
   */
  async _fetchTemplates(endpoint) {
    try {
      const response = await endpoint.getAgentTemplates();
      const templates = response?.templates || [];
      this.templatesByName = templates.reduce((acc, template) => {
        acc[template.name] = template;
        return acc;
      }, {});
      this.logger.info(`AgentStateManager: Loaded ${templates.length} templates`);
    } catch (error) {
      this.logger.error('AgentStateManager: Failed to fetch agent templates:', error);
      throw error;
    }
  }

  /**
   * Fetch settings (central config for defaults)
   * @private
   */
  async _fetchSettings(endpoint) {
    try {
      this.settings = await endpoint.getSettings();
      this.logger.info('AgentStateManager: Loaded settings');
    } catch (error) {
      this.logger.error('AgentStateManager: Failed to fetch settings:', error);
      throw error;
    }
  }

  /**
   * Find agent by name
   * @param {string} agentName - Agent name to search for
   * @returns {Object|null} Agent object or null if not found
   */
  findAgentByName(agentName) {
    if (!agentName || !Array.isArray(this.agents)) return null;
    return this.agents.find((agent) => agent && agent.agent_name === agentName) || null;
  }

  /**
   * Get agent by index
   * @param {number} index - Array index
   * @returns {Object|null} Agent object or null
   */
  getAgent(index) {
    if (index === null || index === undefined || index < 0 || index >= this.agents.length) {
      return null;
    }
    return this.agents[index];
  }

  /**
   * Update agent at index
   * @param {number} index - Array index
   * @param {Object} updates - Fields to update
   */
  updateAgent(index, updates) {
    const agent = this.getAgent(index);
    if (!agent) {
      throw new Error(`Agent at index ${index} not found`);
    }
    Object.assign(agent, updates);
    this.markDirty(agent.agent_name);
  }

  /**
   * Group agents by category (system, tools, other)
   * @param {Array} agents - Array of agent objects (defaults to this.agents)
   * @returns {Object} Grouped agents { system: [], tools: [], other: [] }
   */
  groupAgents(agents = null) {
    const agentList = agents || this.agents || [];
    const system = [];
    const tools = [];
    const other = [];
    
    agentList.forEach((agent, index) => {
      const isTool = agent.execution_trigger === 'on_demand';
      
      if (isTool) {
        tools.push({ agent, index });
      } else {
        system.push({ agent, index });
      }
    });
    
    return { system, tools, other };
  }

  /**
   * Check if agent is a tool (on-demand)
   * @param {Object} agent - Agent object
   * @returns {boolean}
   */
  isToolAgent(agent) {
    return Boolean(
      agent && 
      agent.execution_trigger === 'on_demand'
    );
  }

  /**
   * Get template config for agent
   * @param {string} agentName - Agent name
   * @returns {Object} Template config object
   */
  getTemplateConfig(agentName) {
    const template = this.templatesByName?.[agentName];
    return template?.recommended_config || {};
  }

  /**
   * Get context retrieval defaults from settings
   * @returns {Object} Context defaults { enabled, default_top_k, min_score }
   * @throws {Error} If settings are missing or incomplete
   */
  getContextDefaults() {
    const defaults = this.settings?.agents?.context_retrieval;
    if (!defaults) {
      throw new Error('Missing settings.agents.context_retrieval for defaults');
    }
    if (defaults.enabled === undefined ||
        defaults.default_top_k === undefined ||
        defaults.min_score === undefined) {
      throw new Error('Incomplete context retrieval defaults in settings');
    }
    return {
      enabled: defaults.enabled,
      default_top_k: defaults.default_top_k,
      min_score: defaults.min_score
    };
  }

  /**
   * Mark agent as dirty (has unsaved changes)
   * @param {string} agentName - Agent name
   */
  markDirty(agentName) {
    if (agentName) {
      this.dirtyAgents.add(agentName);
    }
  }

  /**
   * Clear dirty flag for agent
   * @param {string} agentName - Agent name
   */
  markClean(agentName) {
    if (agentName) {
      this.dirtyAgents.delete(agentName);
    }
  }

  /**
   * Check if any agents have unsaved changes
   * @returns {boolean}
   */
  isDirty() {
    return this.dirtyAgents.size > 0;
  }

  /**
   * Get array of dirty agent names
   * @returns {Array<string>}
   */
  getDirtyAgents() {
    return Array.from(this.dirtyAgents);
  }

  /**
   * Clear all dirty flags
   */
  clearDirty() {
    this.dirtyAgents.clear();
  }

  /**
   * Set selected agent index (for system view)
   * @param {number|null} index - Agent index or null to deselect
   */
  setSelectedAgent(index) {
    this.selectedAgent = index;
  }

  /**
   * Get selected agent index
   * @returns {number|null}
   */
  getSelectedAgent() {
    return this.selectedAgent;
  }

  /**
   * Reset all state
   */
  reset() {
    this.agents = [];
    this.models = [];
    this.templatesByName = {};
    this.settings = null;
    this.selectedAgent = null;
    this.dirtyAgents.clear();
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AgentStateManager;
}

// Global registration
if (typeof window !== 'undefined') {
  window.AgentStateManager = AgentStateManager;
}
