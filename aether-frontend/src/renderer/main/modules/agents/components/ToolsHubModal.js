/**
 * @.architecture
 * Incoming: AgentsModal (subclass), user tab clicks --- {render request, view switch}
 * Processing: Provide hub pattern with tabs, view management --- {JOB_RENDER_HUB, JOB_SWITCH_VIEW}
 * Outgoing: HTML string, view state --- {hub layout, active view}
 * 
 * ToolsHubModal - Abstract Base for Tools-First Modal UX
 * 
 * Responsibilities:
 * - Provide two-view architecture (tools vs system)
 * - Manage tab navigation
 * - Render hub header with title + tabs
 * - Render appropriate footer based on view
 * - Handle view switching
 * - Define abstract methods for subclasses
 * 
 * Design Pattern: Template Method Pattern
 * - Base class provides structure
 * - Subclasses implement view-specific rendering
 * 
 * Extracted from AgentsModal.js lines 209-240 (_renderHub, _renderFooter)
 */

'use strict';

const BaseModal = require('../../../../shared/modals/BaseModal');

class ToolsHubModal extends BaseModal {
  /**
   * @param {Object} options - Modal options (passed to BaseModal)
   */
  constructor(options = {}) {
    super(options);
    
    // View state
    this.activeView = 'ondemand'; // ondemand | system | other
  }

  /**
   * Render hub structure (header with tabs + body with view content)
   * @returns {string} HTML string
   * @protected
   */
  _renderHub() {
    return `
      <div class="agents-hub">
        <div class="agents-hub-header">
          <div>
            <div class="agents-hub-title">${this._getHubTitle()}</div>
            <div class="agents-hub-subtitle">${this._getHubSubtitle()}</div>
          </div>
          <div class="agents-hub-tabs" role="tablist" aria-label="View tabs">
            ${this._renderTabs()}
          </div>
        </div>
        <div class="agents-hub-body">
          ${this._renderActiveView()}
        </div>
      </div>
    `;
  }

  /**
   * Render tabs for view switching
   * @returns {string} HTML string
   * @protected
   */
  _renderTabs() {
    const views = this._getViews();
    
    return views.map(view => {
      const isActive = this.activeView === view.id;
      const label = view.label || view.id;
      
      return `
        <button 
          class="btn-ghost btn-sm agents-tab ${isActive ? 'is-active' : ''}" 
          type="button" 
          data-action="set-view" 
          data-view="${view.id}"
        >
          ${label}
        </button>
      `;
    }).join('');
  }

  /**
   * Render active view content
   * @returns {string} HTML string
   * @protected
   */
  _renderActiveView() {
    switch (this.activeView) {
      case 'ondemand':
        return this._renderOndemandView();
      case 'tools': // Legacy fallback
        return this._renderOndemandView();
      case 'system':
        return this._renderSystemView();
      default:
        return this._renderCustomView(this.activeView);
    }
  }

  /**
   * Render footer based on active view
   * @returns {string} HTML string
   * @protected
   */
  _renderModalFooter() {
    if (this.activeView === 'system') {
      return `
        <button class="btn-secondary agents-cancel" type="button">Cancel</button>
        <button class="btn-primary agents-save" type="button">Save Changes</button>
      `;
    }
    return '';
  }

  /**
   * Switch to different view
   * @param {string} viewId - View ID to switch to
   */
  switchView(viewId) {
    if (!viewId) return;
    
    const views = this._getViews();
    const validView = views.find(v => v.id === viewId);
    
    if (!validView) {
      this.logger?.warn?.(`ToolsHubModal: Invalid view ID: ${viewId}`);
      return;
    }
    
    this.activeView = viewId;
    this._onViewChanged(viewId);
  }

  /**
   * Called after view changes (hook for subclasses)
   * @param {string} viewId - New view ID
   * @protected
   */
  _onViewChanged(viewId) {
    // Subclasses can override to handle view change
  }

  // ============================================================================
  // ABSTRACT METHODS - Must be implemented by subclasses
  // ============================================================================

  /**
   * Get hub title
   * @returns {string} Hub title
   * @abstract
   */
  _getHubTitle() {
    throw new Error('ToolsHubModal: _getHubTitle() must be implemented by subclass');
  }

  /**
   * Get hub subtitle
   * @returns {string} Hub subtitle
   * @abstract
   */
  _getHubSubtitle() {
    throw new Error('ToolsHubModal: _getHubSubtitle() must be implemented by subclass');
  }

  /**
   * Get available views
   * @returns {Array<{id: string, label: string}>} Array of view definitions
   * @abstract
   */
  _getViews() {
    throw new Error('ToolsHubModal: _getViews() must be implemented by subclass');
  }

  /**
   * Render on-demand tools view content
   * @returns {string} HTML string
   * @abstract
   */
  _renderOndemandView() {
    throw new Error('ToolsHubModal: _renderOndemandView() must be implemented by subclass');
  }
  
  /**
   * Render tools view content (legacy, calls _renderOndemandView)
   * @returns {string} HTML string
   * @abstract
   */
  _renderToolsView() {
    return this._renderOndemandView();
  }

  /**
   * Render system view content
   * @returns {string} HTML string
   * @abstract
   */
  _renderSystemView() {
    throw new Error('ToolsHubModal: _renderSystemView() must be implemented by subclass');
  }

  /**
   * Render custom view content (optional, for additional views)
   * @param {string} viewId - View ID
   * @returns {string} HTML string
   * @protected
   */
  _renderCustomView(viewId) {
    return `<div class="view-not-implemented">View "${viewId}" not implemented</div>`;
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ToolsHubModal;
}

// Global registration
if (typeof window !== 'undefined') {
  window.ToolsHubModal = ToolsHubModal;
}
