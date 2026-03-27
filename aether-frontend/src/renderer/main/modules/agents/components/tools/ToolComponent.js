/**
 * @.architecture
 * Incoming: AgentsModal, ToolStateManager --- {render request, invoke request}
 * Processing: Define tool interface, provide base utilities --- {JOB_RENDER_CARD, JOB_CREATE_DIALOG}
 * Outgoing: HTML string, Dialog instance --- {card HTML, dialog instance}
 * 
 * ToolComponent - Abstract Base Class for Tool Components
 * 
 * Responsibilities:
 * - Define common interface for all tools
 * - Provide shared utility methods
 * - Standardize tool lifecycle
 * 
 * Subclasses must implement:
 * - render() - Return HTML for tool card
 * - createDialog() - Return dialog instance for tool invocation
 * - invoke(params) - Execute tool with given parameters
 * - getStatus() - Return current tool status
 * 
 * Design Pattern: Template Method Pattern
 * - Base class defines structure
 * - Subclasses implement specifics
 * - Consistent interface across all tools
 */

'use strict';

class ToolComponent {
  /**
   * @param {Object} config - Tool configuration
   * @param {string} config.name - Tool name (e.g., 'research')
   * @param {Object} config.agent - Agent configuration object
   * @param {Object} config.endpoint - API endpoint instance
   * @param {Object} config.toolState - ToolStateManager instance
   * @param {Object} config.logger - Logger instance
   */
  constructor(config = {}) {
    this.name = config.name;
    this.agent = config.agent;
    this.endpoint = config.endpoint;
    this.toolState = config.toolState;
    this.logger = config.logger || console;
    
    if (!this.name) {
      throw new Error('Tool name is required');
    }
    
    if (!this.endpoint) {
      throw new Error('Endpoint is required');
    }
    
    if (!this.toolState) {
      throw new Error('ToolStateManager is required');
    }
  }

  /**
   * Render tool card HTML
   * @returns {string} HTML string for tool card
   * @abstract
   */
  render() {
    throw new Error(`${this.constructor.name}: render() must be implemented by subclass`);
  }

  /**
   * Create dialog instance for tool invocation
   * @returns {Object} Dialog instance
   * @abstract
   */
  createDialog() {
    throw new Error(`${this.constructor.name}: createDialog() must be implemented by subclass`);
  }

  /**
   * Invoke tool with given parameters
   * @param {Object} params - Tool-specific parameters
   * @returns {Promise<Object>} Tool execution result
   * @abstract
   */
  async invoke(params) {
    throw new Error(`${this.constructor.name}: invoke() must be implemented by subclass`);
  }

  /**
   * Get current tool status (for card display)
   * @returns {Object} Status object { available, message, etc }
   * @abstract
   */
  getStatus() {
    throw new Error(`${this.constructor.name}: getStatus() must be implemented by subclass`);
  }

  /**
   * Get recent jobs for this tool
   * @returns {Array} Array of job objects
   */
  getRecentJobs() {
    return this.toolState.getToolJobs(this.name);
  }

  /**
   * Get current run state for this tool
   * @returns {Object|null} Run state object or null
   */
  getRunState() {
    return this.toolState.getToolRunState(this.name);
  }

  /**
   * Format agent name for display
   * @param {string} agentName - Raw agent name
   * @returns {string} Formatted display name
   */
  _formatAgentName(agentName) {
    if (!agentName) return 'Unknown';
    // Check for display name in template (if available)
    // For now, just capitalize and replace underscores
    return String(agentName)
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Escape HTML for safe rendering
   * @param {string} text - Text to escape
   * @returns {string} Escaped HTML
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  /**
   * Format duration in milliseconds to human-readable string
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration
   */
  _formatDuration(ms) {
    const seconds = ms / 1000;
    if (seconds < 1) return `${ms}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m ${remainder}s`;
  }

  /**
   * Format timestamp to relative time (e.g., "2h ago")
   * @param {Date|string} timestamp - Timestamp to format
   * @returns {string} Relative time string
   */
  _formatRelativeTime(timestamp) {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return String(timestamp || '—');
    
    const diffMs = Date.now() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 48) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  }

  /**
   * Check if tool agent exists
   * @returns {boolean}
   */
  isAvailable() {
    return Boolean(this.agent);
  }

  /**
   * Get tool display name
   * @returns {string}
   */
  getDisplayName() {
    return this._formatAgentName(this.name);
  }

  /**
   * Get tool description (from agent or default)
   * @returns {string}
   */
  getDescription() {
    // Subclasses can override or provide description logic
    return `${this.getDisplayName()} tool`;
  }

  /**
   * Cleanup resources (called when tool is destroyed)
   */
  cleanup() {
    // Subclasses can override if cleanup needed
    this.logger.info(`ToolComponent: Cleanup ${this.name}`);
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ToolComponent;
}

// Global registration
if (typeof window !== 'undefined') {
  window.ToolComponent = ToolComponent;
}
